import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "./failureCodes.js";

/**
 * Spend policy: per-intent ceilings and fee-payer velocity circuit breakers.
 *
 * Two independent guards. Both are fail-closed — if the check itself cannot
 * run (missing config, failed store), the broadcast is blocked rather than
 * allowed to proceed silently. A policy check is not a defect in the
 * transaction; it is a deliberate stop, so it is never retriable.
 *
 * ## Why these exist
 *
 * Once the relayer constructs transactions, it is spending user funds on
 * instructions it assembled itself. The cryptographic backstops — user
 * signature, instruction verification — prove the transaction matches the
 * intent, but they do nothing about an *intent that should never be honoured*:
 * a compromise that submits a genuinely huge payment, or a runaway loop that
 * broadcasts a thousand small ones. These breakers catch that class.
 */

/**
 * Thrown when a spend policy refuses a transaction.
 *
 * Carries the structured failure so the job row records which threshold was
 * crossed and why. Distinct class so callers can route it to the
 * `PolicyCheck` stage and log the full context.
 */
export class SpendPolicyError extends Error {
  readonly failure: RelayerFailure;

  constructor(code: string, detail: string) {
    super(detail);
    this.name = "SpendPolicyError";
    this.failure = relayerFailure(RelayerFailureStage.PolicyCheck, code, detail, false);
  }
}

/** Ceiling configuration for one mint, in base units. */
export interface AmountCeiling {
  /** The intent's mint asset (base58). */
  asset: string;
  /** Maximum amount in the mint's smallest unit. */
  maxAmount: bigint;
}

/**
 * Velocity configuration for the fee-payer key.
 *
 * Value caps are **per asset**, keyed by mint. A single shared figure would be
 * incoherent: base units are not comparable across mints, so one number
 * simultaneously means "10,000 USDC" (6 decimals) and "10 SOL" (9 decimals) —
 * wildly different amounts of money. Whichever asset the number was calibrated
 * for, it is wrong by the price ratio for the other, and no single value can be
 * correct for both.
 *
 * The count cap is deliberately **not** per asset. It exists to catch a runaway
 * loop or a compromised key hammering the relayer, which is a property of the
 * fee payer's behaviour rather than of any one mint — and an attacker able to
 * split volume across assets should not get a fresh count budget for each.
 */
export interface VelocityConfig {
  /**
   * Platform-wide caps, across every team.
   *
   * Catches what a per-team cap cannot: a compromised fee-payer key, or many
   * teams collectively draining the shared fee payer even though each stays
   * inside its own allowance.
   */
  global: VelocityCaps;
  /**
   * Caps applied to each team's own window, independently.
   *
   * Without these, the platform-wide cap is a shared budget that the busiest
   * tenant consumes on everyone's behalf — one team's burst halts broadcasts for
   * every other team. That is an availability equivalent of a cross-tenant data
   * leak: one tenant's behaviour visibly degrading another's service.
   */
  perTeam: VelocityCaps;
  /** Rolling window length, milliseconds. Shared by both scopes. */
  windowMs: number;
}

/** One scope's thresholds. Applied identically to the global and per-team windows. */
export interface VelocityCaps {
  /** Maximum aggregate value per mint, in that mint's base units. */
  maxValuePerAsset: Map<string, bigint>;
  /** Maximum transactions across all assets in the window. */
  maxCountPerWindow: number;
}

/** A transaction that was broadcast, for the rolling-window tracker. */
export interface BroadcastRecord {
  /** Value the transaction moved, in `asset`'s base units. */
  value: bigint;
  /**
   * Mint whose base units `value` is denominated in. `null` when the asset
   * could not be determined — such transactions are refused before reaching
   * the tracker, so this exists only for completeness.
   */
  asset: string | null;
  /** Unix milliseconds when it was broadcast. */
  at: number;
}

/**
 * Backend that records and queries broadcast history for the velocity check.
 *
 * Pluggable so the relayer can back it with Redis (the queue is already there)
 * without this module caring. Implementations must be safe against concurrent
 * access; the check runs in the worker.
 *
 * Both per-team and global windows are tracked. Without per-team scoping, the
 * platform-wide count cap is a shared budget consumed by whichever tenant
 * arrives first — one team's burst halts broadcasts for every other team, an
 * availability leak with the same tenant-isolation shape as a cross-tenant data
 * leak. With per-team windows each tenant has their own allowance, and a halt
 * names the responsible party.
 */
export interface VelocityStore {
  /**
   * Record a broadcast so it counts toward both the team's window and the
   * global aggregate.
   */
  record(record: BroadcastRecord, teamId: string): Promise<void>;
  /**
   * Window state ending at `now`, scoped to one team.
   *
   * `valueByAsset` is keyed by mint so each asset's cap is compared against its
   * own total. `count` spans every asset, matching the count cap's scope.
   */
  teamWindow(
    teamId: string,
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }>;
  /**
   * Global window state ending at `now`, aggregated across every team.
   *
   * Same shape as the per-team window: per-asset value totals and a
   * cross-asset count, but summed platform-wide rather than for one tenant.
   */
  globalWindow(
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }>;
}

/** In-memory implementation, adequate for a single worker instance. */
export class InMemoryVelocityStore implements VelocityStore {
  private records: Array<BroadcastRecord & { teamId: string }> = [];

  async record(record: BroadcastRecord, teamId: string): Promise<void> {
    this.records.push({ ...record, teamId });
    // Opportunistic trim so the list does not grow without bound.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    this.records = this.records.filter((r) => r.at >= cutoff);
  }

  async teamWindow(
    teamId: string,
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }> {
    return this.aggregate(now, windowMs, (r) => r.teamId === teamId);
  }

  async globalWindow(
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }> {
    return this.aggregate(now, windowMs, () => true);
  }

  private aggregate(
    now: number,
    windowMs: number,
    include: (r: BroadcastRecord & { teamId: string }) => boolean,
  ): { valueByAsset: Map<string, bigint>; count: number } {
    const cutoff = now - windowMs;
    const inWindow = this.records.filter((r) => r.at >= cutoff && include(r));

    const valueByAsset = new Map<string, bigint>();
    for (const r of inWindow) {
      // An unknown asset is bucketed under a sentinel rather than dropped, so
      // it cannot silently escape accounting if such a record ever appears.
      const key = r.asset ?? "";
      valueByAsset.set(key, (valueByAsset.get(key) ?? 0n) + r.value);
    }

    return { valueByAsset, count: inWindow.length };
  }
}

/** Evaluate whether an amount is within the per-asset ceiling. */
function checkAmountCeiling(
  amount: bigint,
  asset: string | null,
  ceilings: AmountCeiling[],
): void {
  if (amount <= 0n) {
    throw new SpendPolicyError(
      "NON_POSITIVE_AMOUNT",
      `intent amount must be positive, got ${amount}`,
    );
  }

  let ceiling: bigint | null = null;
  if (asset) {
    const entry = ceilings.find((c) => c.asset === asset);
    if (entry) ceiling = entry.maxAmount;
  }

  if (ceiling === null) {
    // No explicit per-asset ceiling configured. Fail closed: do not guess.
    // A missing ceiling is a config gap, not a reason to allow an unbounded
    // payment. This is deliberately conservative — see the config in routes.
    throw new SpendPolicyError(
      "NO_CEILING_CONFIGURED",
      `no spend ceiling configured for asset '${asset ?? "(unknown)"}'`,
    );
  }

  if (amount > ceiling) {
    throw new SpendPolicyError(
      "AMOUNT_EXCEEDS_CEILING",
      `intent amount ${amount} exceeds configured ceiling ${ceiling} for asset '${asset}'`,
    );
  }
}

/**
 * Gate an intent before construction/broadcast.
 *
 * Runs the per-intent amount ceiling. The velocity check is deliberately NOT
 * here — it runs at broadcast time against the live store, after the
 * transaction exists.
 *
 * Fail-closed: a transaction that cannot be valued, or an amount with no
 * configured ceiling, is refused.
 */
export function checkSpendPolicy(
  intent: {
    amount: bigint;
    asset?: string | null;
  },
  ceilings: AmountCeiling[],
): void {
  checkAmountCeiling(intent.amount, intent.asset ?? null, ceilings);
}

/** Which scope a velocity refusal came from. */
export type VelocityScope = "global" | "team";

/**
 * Evaluate one scope's window against its caps.
 *
 * Returns the error rather than throwing so the caller controls ordering — both
 * scopes are evaluated against already-read windows, and the caller decides
 * which breach to report when both are breached.
 */
function evaluateCaps(
  scope: VelocityScope,
  window: { valueByAsset: Map<string, bigint>; count: number },
  value: bigint,
  asset: string,
  caps: VelocityCaps,
  teamId: string,
): SpendPolicyError | null {
  const cap = caps.maxValuePerAsset.get(asset);
  if (cap === undefined) {
    return new SpendPolicyError(
      "NO_VELOCITY_CAP_CONFIGURED",
      `no ${scope} velocity cap configured for asset '${asset}'`,
    );
  }

  // Compare this asset's own total against this asset's own cap. Summing across
  // mints would be meaningless: base units are not commensurable, so adding
  // USDC (6dp) to SOL lamports (9dp) produces a number denominated in nothing.
  const spentForAsset = window.valueByAsset.get(asset) ?? 0n;
  if (spentForAsset + value > cap) {
    return new SpendPolicyError(
      scope === "global" ? "FEE_PAYER_VALUE_LIMIT" : "TEAM_VALUE_LIMIT",
      `broadcast would push ${spentForAsset + value} base units of '${asset}' through the ` +
        `${scope === "global" ? "fee payer" : `team ${teamId}`} in the window, above the ` +
        `${cap} ${scope} cap for that asset`,
    );
  }

  // The count cap spans every asset: it guards against a runaway loop or a
  // compromised key, which is a property of the actor rather than of any one
  // mint. Per-asset counts would hand an attacker a fresh budget for each asset
  // they split volume across.
  if (window.count + 1 > caps.maxCountPerWindow) {
    return new SpendPolicyError(
      scope === "global" ? "FEE_PAYER_COUNT_LIMIT" : "TEAM_COUNT_LIMIT",
      `broadcast would be the ${window.count + 1}th ${scope === "global" ? "" : `for team ${teamId} `}` +
        `in the window, above the ${caps.maxCountPerWindow} ${scope} cap`,
    );
  }

  return null;
}

/**
 * Gate a broadcast against the fee-payer's velocity, globally and per team.
 *
 * Reads both rolling windows from the store, checks value and count caps in
 * each, and only records the broadcast once both pass. Fail-closed: if a store
 * read or write throws, the broadcast is blocked.
 *
 * Both scopes are enforced because neither subsumes the other:
 *
 * - **Global** catches a compromised fee-payer key, and many teams collectively
 *   draining the shared fee payer while each stays inside its own allowance.
 * - **Per-team** stops one tenant consuming the platform's whole budget. Without
 *   it the global cap is a shared pool that the busiest tenant exhausts on
 *   everyone's behalf, halting broadcasts for every other team.
 *
 * Global is reported first when both are breached, so a platform-wide condition
 * is not misattributed to whichever tenant happened to arrive at the wrong
 * moment — the same ordering rule as the SOL budget.
 *
 * @throws {SpendPolicyError} on threshold breach or store failure
 */
export async function checkFeePayerVelocity(
  store: VelocityStore,
  value: bigint,
  asset: string | null,
  config: VelocityConfig,
  teamId: string,
  now: number = Date.now(),
): Promise<void> {
  // An unvaluable asset cannot be checked against a per-asset cap. Refuse
  // rather than fall through to an unbounded broadcast — the same fail-closed
  // reasoning as a missing ceiling.
  if (!asset) {
    throw new SpendPolicyError(
      "NO_VELOCITY_CAP_CONFIGURED",
      "cannot apply a velocity cap without knowing the asset; refusing to broadcast",
    );
  }

  let globalWin;
  let teamWin;
  try {
    globalWin = await store.globalWindow(now, config.windowMs);
    teamWin = await store.teamWindow(teamId, now, config.windowMs);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new SpendPolicyError(
      "VELOCITY_STORE_UNAVAILABLE",
      `velocity store unavailable, refusing to broadcast: ${reason}`,
    );
  }

  const globalBreach = evaluateCaps("global", globalWin, value, asset, config.global, teamId);
  if (globalBreach) throw globalBreach;

  const teamBreach = evaluateCaps("team", teamWin, value, asset, config.perTeam, teamId);
  if (teamBreach) throw teamBreach;

  try {
    await store.record({ value, asset, at: now }, teamId);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new SpendPolicyError(
      "VELOCITY_STORE_WRITE_FAILED",
      `velocity store write failed, refusing to broadcast: ${reason}`,
    );
  }
}
