import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "./failureCodes.js";

/**
 * Rolling SOL spend budget for the fee payer.
 *
 * ## Why this exists
 *
 * Per-asset value ceilings only work for tokens whose worth is known. With open
 * token support, an unlisted mint has no meaningful value cap: base units of an
 * arbitrary token could be worth anything, and there is no price oracle in this
 * system to say which. Capping *quantity* would bound nothing.
 *
 * What is always measurable is what the relayer itself spends — lamports, on
 * transaction fees and on rent for associated token accounts it creates. That
 * is the real exposure: anyone can mint a worthless token and send dust to fresh
 * recipients, and the relayer funds ~0.002 SOL of ATA rent every time.
 *
 * So the guard shifts denomination. For USDC and SOL, value ceilings protect the
 * *user* from an oversized payment. For everything else, this budget protects
 * the *relayer* from fee drain. Those are different goals, and only the second
 * is expressible without an oracle.
 *
 * ## Dual caps
 *
 * Global and per-team, both enforced:
 *
 * - **Global** bounds total exposure. Without it, N teams each spending their
 *   full allowance drains N x the intended maximum from one shared pool.
 * - **Per-team** bounds any single actor. Without it, one compromised key
 *   consumes the entire global budget and starves every honest team.
 *
 * Neither subsumes the other, which is why both are checked. Global is checked
 * first, so a genuine platform-wide problem is reported as such rather than
 * being misattributed to whichever team happened to arrive at the wrong moment.
 *
 * ## Pessimistic reservation
 *
 * Cost is not knowable before broadcast: priority fees vary, and ATA rent is
 * only owed if the account does not already exist. So the worst case is
 * *reserved* up front and reconciled down once the real cost is known.
 *
 * Reserving high fails safe. Under-reserving would let concurrent workers each
 * see room that is not there and collectively breach the cap — the classic
 * check-then-act race, except the resource is money.
 *
 * All arithmetic is `bigint` lamports. Floats are not permitted anywhere in this
 * module: a rounding drift in a rate limit compounds silently over a window.
 */

/** Base transaction fee per signature, in lamports. Fixed by the runtime. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/**
 * Rent-exempt minimum for an SPL token account, in lamports.
 *
 * A token account is 165 bytes, and the rent-exempt minimum for that size is
 * 2_039_280 lamports (~0.00204 SOL). Hardcoded rather than fetched because it
 * is a function of account size and the rent parameters, which have been stable
 * since genesis — and because a broadcast-path RPC call to learn it would be a
 * dependency on the network being healthy in order to decide whether to use the
 * network.
 *
 * If Solana's rent parameters ever change, this becomes an under-estimate and
 * the budget under-reserves. That is the failure direction to watch.
 */
export const ATA_RENT_LAMPORTS = 2_039_280n;

/**
 * Worst-case lamport cost of relaying one transaction.
 *
 * Assumes two signatures (user and fee payer) and that ATA(s) must be created.
 * Both assumptions are deliberately the expensive branch.
 *
 * Rent is per account, and a payment with fees can create several ATAs in one
 * transaction — the recipient's and one for each fee destination. `ataCreations`
 * therefore multiplies, and the default (1) matches the historical single-ATA
 * assumption: this function must never under-reserve when a fee list could be
 * present.
 */
export function worstCaseCostLamports(opts: {
  signatures?: number;
  /**
   * How many ATA creations the transaction may carry. Use
   * `constructed.ataCreationCount` when the transaction is built; default 1 is
   * the safe figure for anything not yet constructed.
   */
  ataCreations?: number;
  /** Priority fee in lamports, if the transaction sets one. */
  priorityFeeLamports?: bigint;
}): bigint {
  const signatures = BigInt(opts.signatures ?? 2);
  const base = LAMPORTS_PER_SIGNATURE * signatures;
  const rent = ATA_RENT_LAMPORTS * BigInt(opts.ataCreations ?? 1);
  const priority = opts.priorityFeeLamports ?? 0n;
  return base + rent + priority;
}

/** Caps for the rolling window, in lamports. */
export interface SolBudgetConfig {
  /** Ceiling across every team combined. */
  globalMaxLamports: bigint;
  /** Ceiling for any one team. Must not exceed the global cap to be meaningful. */
  perTeamMaxLamports: bigint;
  /** Rolling window length, milliseconds. */
  windowMs: number;
}

/**
 * SOL budget configuration, shared between ingress and worker.
 *
 * Both paths must enforce the same caps — duplicating these numbers would
 * invite drift, where one path accepts what the other refuses.
 *
 * Per-team is deliberately set below where per-team velocity binds (10 tx/hour),
 * so the two guards reinforce each other rather than one masking the other. At
 * worst case (2.05M lamports/tx), 10 transactions cost ~20M lamports, so both
 * caps trip at approximately the same point. That makes the SOL budget a
 * meaningful backstop rather than dead code: a misconfigured velocity cap
 * doesn't leave it as the sole line.
 *
 * TODO(2026-08-02): provisional, same as the value ceilings and velocity caps.
 * Re-derive from observed fee-payer spend once metering has real volume, and
 * revisit alongside the ceilings in `spendCeilings.ts` and the velocity caps in
 * `broadcast.ts`.
 */
export const DEFAULT_SOL_BUDGET_CONFIG: SolBudgetConfig = {
  /** 1 SOL/hour across every team. */
  globalMaxLamports: 1_000_000_000n,
  /** 0.02 SOL/hour per team — binds at ~10 worst-case transactions, the same
   * point per-team velocity does (10 tx/hour count cap). */
  perTeamMaxLamports: 20_000_000n,
  windowMs: 60 * 60 * 1000,
};

/** A reservation held against the budget. */
export interface SolReservation {
  /** Opaque handle for reconciliation or release. */
  id: string;
  /** Team that owns the spend. */
  teamId: string;
  /** Lamports currently held. */
  lamports: bigint;
  /** When it was taken, for window expiry. */
  at: number;
}

/** Aggregate state of the window. */
export interface SolBudgetWindow {
  /** Lamports reserved or spent across all teams. */
  globalLamports: bigint;
  /** Lamports reserved or spent by the queried team. */
  teamLamports: bigint;
  /**
   * Timestamp of the oldest entry still counting, or null when empty. Used to
   * compute `Retry-After`: budget frees up when this entry leaves the window.
   */
  oldestAt: number | null;
}

/**
 * Persistence for the rolling budget.
 *
 * Separated from the policy so it can be backed by Redis — the same reasoning
 * as `VelocityStore`: a process-local budget resets on restart, and a budget
 * that forgets what it spent is not a budget.
 */
export interface SolBudgetStore {
  /** Take a reservation and return it. Must be atomic with respect to reads. */
  reserve(reservation: SolReservation): Promise<void>;
  /** Adjust a held reservation to its actual cost once known. */
  reconcile(id: string, actualLamports: bigint): Promise<void>;
  /** Drop a reservation entirely — the transaction never went out. */
  release(id: string): Promise<void>;
  /** Window state, ending at `now`, for one team and globally. */
  window(teamId: string, now: number, windowMs: number): Promise<SolBudgetWindow>;
}

/**
 * Which ceiling a refusal hit.
 *
 * Distinguished because the operator response differs: a global breach means
 * the platform is at capacity or under attack, a per-team breach means one
 * tenant is misbehaving.
 */
export type SolBudgetBreach = "global" | "team";

/** Refusal from the SOL budget. Temporary — the window will free up. */
export class SolBudgetExceededError extends Error {
  readonly failure: RelayerFailure;

  constructor(
    readonly breach: SolBudgetBreach,
    /** Seconds until enough budget frees to retry. */
    readonly retryAfterSeconds: number,
    detail: string,
  ) {
    super(detail);
    this.name = "SolBudgetExceededError";
    this.failure = relayerFailure(
      RelayerFailureStage.PolicyCheck,
      breach === "global" ? "SOL_BUDGET_GLOBAL_EXCEEDED" : "SOL_BUDGET_TEAM_EXCEEDED",
      detail,
      // Retriable, unlike every other policy refusal in this codebase. The
      // transaction is not defective — the relayer is temporarily out of budget,
      // and the same transaction will succeed once the window rolls. Marking it
      // permanent would discard legitimate work.
      true,
    );
  }
}

/**
 * Failure codes meaning "defer and retry", not "this job failed".
 *
 * The single source of truth for the worker's deferral decision. Every code here
 * describes a *relayer* condition — out of budget, or unable to read the budget —
 * never a defect in the transaction. The bytes are fine and will settle once the
 * condition clears, so burning a retry attempt on each one would exhaust
 * `BULL_MAX_ATTEMPTS` well inside the window and discard legitimate work.
 */
export const SOL_BUDGET_DEFERRAL_CODES: ReadonlySet<string> = new Set([
  "SOL_BUDGET_GLOBAL_EXCEEDED",
  "SOL_BUDGET_TEAM_EXCEEDED",
  "SOL_BUDGET_STORE_UNAVAILABLE",
]);

/**
 * Check whether a broadcast result means "defer and retry" rather than "failed".
 *
 * True when the failure code is in `SOL_BUDGET_DEFERRAL_CODES`, meaning the
 * relayer is temporarily out of budget or unable to check budget. The transaction
 * itself is fine and will settle once the condition clears.
 */
export function isSolBudgetDeferral(result: { success: boolean; failure?: { code?: string } }): boolean {
  if (result.success) return false;
  const code = result.failure?.code;
  return code != null && SOL_BUDGET_DEFERRAL_CODES.has(code);
}

/**
 * Deferral delay when the budget store is unreachable.
 *
 * Deliberately short, and much shorter than a window-expiry wait: a store outage
 * is an infrastructure blip that may clear in seconds, whereas an exhausted
 * budget genuinely needs the window to roll. Waiting an hour for a Redis
 * reconnect would strand work for no reason.
 */
export const SOL_BUDGET_STORE_RETRY_SECONDS = 30;

/**
 * Read the deferral delay off a broadcast result.
 *
 * The SOL budget paths set `retryAfterSeconds` explicitly — a window-expiry
 * estimate for a cap breach, or `SOL_BUDGET_STORE_RETRY_SECONDS` for a store
 * outage. The fallback exists only so a malformed result cannot produce
 * `NaN`/`undefined` and reschedule a job to an invalid timestamp; it is the
 * conservative short delay rather than a full window, since reaching it means
 * the caller failed to state a delay and guessing long would strand the work.
 */
export function retryAfterSecondsFrom(result: { retryAfterSeconds?: number }): number {
  const seconds = result.retryAfterSeconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return SOL_BUDGET_STORE_RETRY_SECONDS;
  }
  return Math.ceil(seconds);
}

/** Raised when the store itself fails. Fail-closed: refuse the broadcast. */
export class SolBudgetUnavailableError extends Error {
  readonly failure: RelayerFailure;

  constructor(reason: string) {
    super(`SOL budget store unavailable, refusing to broadcast: ${reason}`);
    this.name = "SolBudgetUnavailableError";
    this.failure = relayerFailure(
      RelayerFailureStage.PolicyCheck,
      "SOL_BUDGET_STORE_UNAVAILABLE",
      this.message,
      // Retriable: the store being down is transient, and the transaction is
      // fine. Refuse now, let the queue try again.
      true,
    );
  }
}

/**
 * Seconds until `lamportsNeeded` frees up, given the oldest entry in the window.
 *
 * Approximate by design: it reports when the *oldest* entry expires, which is
 * the soonest any budget is released. Whether that release is enough depends on
 * how much that entry held, which the caller cannot know without reading every
 * entry. Erring early means a client may retry once and be refused again, which
 * is cheaper than telling it to wait longer than necessary.
 *
 * Minimum of 1 second so a client never receives `Retry-After: 0` and hot-loops.
 */
export function retryAfterSeconds(
  oldestAt: number | null,
  now: number,
  windowMs: number,
): number {
  if (oldestAt === null) {
    // Nothing in the window, yet the cap was hit — the request alone exceeds
    // the ceiling and no amount of waiting helps. Report the full window rather
    // than implying an immediate retry will work.
    return Math.ceil(windowMs / 1000);
  }
  const freesAt = oldestAt + windowMs;
  return Math.max(1, Math.ceil((freesAt - now) / 1000));
}

/**
 * Reserve worst-case lamports for a broadcast, or refuse.
 *
 * Checks the global ceiling first, then the team's. Only takes the reservation
 * once both pass, so a refused attempt consumes no budget — otherwise repeated
 * refusals would compound into an outage longer than the breach warrants.
 *
 * @returns the reservation id, for `reconcileSolSpend` or `releaseSolReservation`
 * @throws {SolBudgetExceededError} when either ceiling would be breached
 * @throws {SolBudgetUnavailableError} when the store cannot be read or written
 */
export async function reserveSolSpend(
  store: SolBudgetStore,
  args: {
    teamId: string;
    lamports: bigint;
    reservationId: string;
  },
  config: SolBudgetConfig,
  now: number = Date.now(),
): Promise<string> {
  let window: SolBudgetWindow;
  try {
    window = await store.window(args.teamId, now, config.windowMs);
  } catch (e) {
    throw new SolBudgetUnavailableError(e instanceof Error ? e.message : String(e));
  }

  // Global first: a platform-wide breach should be reported as such rather than
  // blamed on whichever team happened to arrive when the pool ran dry.
  if (window.globalLamports + args.lamports > config.globalMaxLamports) {
    throw new SolBudgetExceededError(
      "global",
      retryAfterSeconds(window.oldestAt, now, config.windowMs),
      `Relaying this transaction would take total fee-payer spend to ` +
        `${window.globalLamports + args.lamports} lamports in the window, above the ` +
        `${config.globalMaxLamports} platform ceiling. This is a temporary limit — retry shortly.`,
    );
  }

  if (window.teamLamports + args.lamports > config.perTeamMaxLamports) {
    throw new SolBudgetExceededError(
      "team",
      retryAfterSeconds(window.oldestAt, now, config.windowMs),
      `Relaying this transaction would take this team's fee-payer spend to ` +
        `${window.teamLamports + args.lamports} lamports in the window, above the ` +
        `${config.perTeamMaxLamports} per-team ceiling. This is a temporary limit — retry shortly.`,
    );
  }

  try {
    await store.reserve({
      id: args.reservationId,
      teamId: args.teamId,
      lamports: args.lamports,
      at: now,
    });
  } catch (e) {
    throw new SolBudgetUnavailableError(e instanceof Error ? e.message : String(e));
  }

  return args.reservationId;
}

/**
 * Read-only admission check, for the ingress path.
 *
 * Answers "would a reservation of `lamports` be refused right now?" without
 * taking one. Deliberately does not reserve: the worker reserves at broadcast
 * time, and a reservation here would double-count every transaction — inflating
 * the window by 2x and halving the effective cap.
 *
 * That makes this advisory, and it is worth being precise about what it can and
 * cannot promise. It is a *fast refusal*, not an admission guarantee:
 *
 * - Passing here does not guarantee the worker's reservation succeeds. Other
 *   traffic can consume the remaining budget between accept and broadcast, in
 *   which case the worker defers the job — the outcome the caller would have
 *   had anyway without this check.
 * - Failing here is reliable in the direction that matters. The window is
 *   already over the ceiling, so queueing the job would produce a job that sits
 *   deferred until the window rolls.
 *
 * The value is telling a client *now*, synchronously, with a `Retry-After` it
 * can act on — rather than returning 202, having it poll a job that cannot
 * progress, and burning queue depth and a credit on work known to be blocked.
 *
 * Returns `null` when there is room. Returns the error when there is not, rather
 * than throwing, because at ingress this is an ordinary response to serialize,
 * not an exceptional condition.
 */
export async function checkSolBudgetAvailable(
  store: SolBudgetStore,
  args: { teamId: string; lamports: bigint },
  config: SolBudgetConfig,
  now: number = Date.now(),
): Promise<SolBudgetExceededError | SolBudgetUnavailableError | null> {
  let window: SolBudgetWindow;
  try {
    window = await store.window(args.teamId, now, config.windowMs);
  } catch (e) {
    // Fail-closed, consistent with every other policy gate: a budget that
    // cannot be read is not evidence of headroom. Retriable, and with a short
    // delay — a store outage is an infra blip, not an exhausted window.
    return new SolBudgetUnavailableError(e instanceof Error ? e.message : String(e));
  }

  // Global first, for the same reason as `reserveSolSpend`: a platform-wide
  // breach must not be reported to a tenant as their own overspend.
  if (window.globalLamports + args.lamports > config.globalMaxLamports) {
    return new SolBudgetExceededError(
      "global",
      retryAfterSeconds(window.oldestAt, now, config.windowMs),
      `Relaying this transaction would take total fee-payer spend to ` +
        `${window.globalLamports + args.lamports} lamports in the window, above the ` +
        `${config.globalMaxLamports} platform ceiling. This is a temporary limit — retry shortly.`,
    );
  }

  if (window.teamLamports + args.lamports > config.perTeamMaxLamports) {
    return new SolBudgetExceededError(
      "team",
      retryAfterSeconds(window.oldestAt, now, config.windowMs),
      `Relaying this transaction would take this team's fee-payer spend to ` +
        `${window.teamLamports + args.lamports} lamports in the window, above the ` +
        `${config.perTeamMaxLamports} per-team ceiling. This is a temporary limit — retry shortly.`,
    );
  }

  return null;
}

/**
 * Adjust a reservation to what the transaction actually cost.
 *
 * Called after settlement, when the real fee is known and whether an ATA was
 * created is settled. Releases the over-reserved difference back to the window.
 *
 * Deliberately does not throw. Reconciliation failing leaves the reservation at
 * its worst-case figure, which over-counts spend and is therefore safe — the
 * budget is tighter than reality rather than looser. Throwing here would turn a
 * bookkeeping problem into a failed job for a transaction that already landed.
 */
export async function reconcileSolSpend(
  store: SolBudgetStore,
  id: string,
  actualLamports: bigint,
  onError?: (reason: string) => void,
): Promise<void> {
  try {
    await store.reconcile(id, actualLamports);
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Drop a reservation whose transaction never went out.
 *
 * Same non-throwing rationale as reconciliation: failing to release leaves
 * budget held that should have been freed, which is conservative. The window
 * will expire it regardless.
 */
export async function releaseSolReservation(
  store: SolBudgetStore,
  id: string,
  onError?: (reason: string) => void,
): Promise<void> {
  try {
    await store.release(id);
  } catch (e) {
    onError?.(e instanceof Error ? e.message : String(e));
  }
}
