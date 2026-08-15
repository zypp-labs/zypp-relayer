import { randomUUID } from "node:crypto";
import {
  Connection,
  Commitment,
  SendOptions,
  PublicKey,
  VersionedTransaction,
  type Keypair,
} from "@solana/web3.js";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { classifyError } from "./classify.js";
import { coSignAsFeePayerWithKeys, loadFeePayerKeypairs, type IntentEnvelope } from "../lib/feePayer.js";
import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "../lib/failureCodes.js";
import { extractTransferValue } from "../lib/outboundVerification.js";
import {
  checkSpendPolicy,
  checkFeePayerVelocity,
  SpendPolicyError,
  type VelocityStore,
  type VelocityConfig,
} from "../lib/spendPolicy.js";
import { DEFAULT_AMOUNT_CEILINGS, MINTS } from "../lib/spendCeilings.js";
import { cachedDecimals, resolveMint } from "../lib/mintDecimals.js";
import {
  reserveSolSpend,
  reconcileSolSpend,
  releaseSolReservation,
  worstCaseCostLamports,
  SolBudgetExceededError,
  SolBudgetUnavailableError,
  SOL_BUDGET_STORE_RETRY_SECONDS,
  DEFAULT_SOL_BUDGET_CONFIG,
  type SolBudgetConfig,
  type SolBudgetStore,
} from "../lib/solBudget.js";
import type { AlertNotifier, CircuitBreakerAlert } from "../lib/alerting.js";
import { parseIntentPayload, isTransferIntent } from "../lib/validate.js";
import {
  constructAndSignSettlement,
  loadDelegateKeypair,
  type SettlementTerms,
} from "../lib/settlement.js";
import { toBaseUnits } from "../lib/amounts.js";

/**
 * Rolling window for the fee-payer velocity cap, global and per team.
 *
 * Value caps are **per asset**, and must be. Base units are not commensurable
 * across mints: a single shared figure would mean "10,000 USDC" (6 decimals)
 * and "10 SOL" (9 decimals) at the same time — quantities differing by orders
 * of magnitude in real value. Whichever asset such a number were calibrated
 * for, it would be wrong by the price ratio for the other, and no single value
 * can be correct for both. Each asset therefore gets its own cap, compared
 * against its own running total.
 *
 * The count cap is deliberately shared across assets within each scope. It
 * guards against a runaway loop or a compromised key — a property of the actor's
 * behaviour, not of any one mint — and a per-asset count would hand an attacker
 * a fresh budget for every asset they split volume across.
 *
 * **Both scopes are enforced, because neither subsumes the other.** The global
 * caps bound total exposure: a compromised fee-payer key, or many teams
 * collectively draining the shared pool while each stays inside its own
 * allowance. The per-team caps stop one tenant consuming the entire platform
 * budget — without them the global cap is a shared pool that the busiest tenant
 * exhausts on everyone's behalf, halting broadcasts for every other team. That
 * is an availability failure with the same tenant-isolation shape as a
 * cross-tenant data leak, and it was the state before per-team scoping existed.
 *
 * Per-team caps are set at 1/4 of global, so no single tenant can consume more
 * than a quarter of the platform's hourly budget, and four busy tenants can
 * coexist without contending. The ratio is a judgement about fair sharing, not a
 * measurement.
 *
 * These are **backstops, not predictions**. Global caps sit at roughly 20x the
 * per-intent ceiling: generous enough that real beta traffic should never
 * approach them, tight enough that a compromise or a loop is caught within the
 * hour rather than draining unboundedly. An absent cap is not a neutral choice —
 * it is the choice to have no aggregate limit at all, which is the exact gap
 * this guard exists to close.
 *
 * TODO(2026-08-02): re-derive every figure from observed p99 once B2's metering
 * has collected real volume. Tracked with the per-intent ceilings in
 * `spendCeilings.ts`; revisit together, since both the 20x global relationship
 * and the 1/4 per-team ratio are assumptions rather than measurements.
 */
const VELOCITY_WINDOW: VelocityConfig = {
  global: {
    maxValuePerAsset: new Map<string, bigint>([
      // $2,000 USDC/hour — 20x the $100 per-intent ceiling. 6 decimals.
      [MINTS.USDC, 2_000_000_000n],
      // 24 SOL/hour — 20x the 1.2 SOL per-intent ceiling. 9 decimals.
      [MINTS.WSOL, 24_000_000_000n],
    ]),
    /** Shared across assets — see above. */
    maxCountPerWindow: 40,
  },
  perTeam: {
    maxValuePerAsset: new Map<string, bigint>([
      // $500 USDC/hour — a quarter of the platform budget.
      [MINTS.USDC, 500_000_000n],
      // 6 SOL/hour — a quarter of the platform budget.
      [MINTS.WSOL, 6_000_000_000n],
    ]),
    /** A quarter of the global count, so four busy tenants can coexist. */
    maxCountPerWindow: 10,
  },
  windowMs: 60 * 60 * 1000,
};

/**
 * Rolling SOL spend budget for the fee payer.
 *
 * This is the guard that makes open token support defensible. A value ceiling
 * requires knowing what a token is worth, which needs an oracle this system does
 * not have — so for any mint without an explicit ceiling, the only bound that
 * means anything is what the *relayer* spends: fees plus ATA rent.
 *
 * Dual caps because neither subsumes the other. Without the global cap, N teams
 * each spending a full per-team allowance drain N x the intended maximum from one
 * shared fee payer. Without the per-team cap, one compromised key consumes the
 * whole global budget and starves every honest team.
 *
 * ATA rent (~0.00204 SOL) dominates: it is roughly 200x a signature fee, so the
 * realistic drain is someone minting a worthless token and spraying dust at fresh
 * recipients. At the caps below that costs about 49 ATAs per team per hour, and
 * ~490 platform-wide.
 *
 * The figures live in `solBudget.ts` because ingress enforces the same ceilings
 * before queueing. Two copies would drift, and the failure would be silent: the
 * API would accept work the worker then refuses, leaving jobs deferred until the
 * window rolls with nothing explaining why.
 */
const SOL_BUDGET: SolBudgetConfig = DEFAULT_SOL_BUDGET_CONFIG;

/** ATA program, for recognising a create-account instruction post-hoc. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/**
 * What a broadcast transaction actually cost, in lamports.
 *
 * Signature count is exact — it is a property of the serialized transaction.
 * ATA rent is inferred from whether the instruction set contains a call to the
 * Associated Token Account program: querying the chain to confirm would be
 * another RPC round trip for a figure used only for bookkeeping.
 *
 * Priority fees are not accounted for. A transaction carrying one will be
 * reconciled slightly low, which under-counts spend — the one direction in this
 * module that is not conservative. Acceptable because the relayer does not
 * currently set priority fees, and noted here so it is not forgotten if it
 * starts to.
 */
/**
 * Count Associated Token Account creations in a serialized transaction.
 *
 * Used for the pessimistic reservation before broadcast, so it errs upward: a
 * transaction that cannot be parsed reports 1 rather than 0, because reserving
 * nothing for an unparseable transaction is the direction that overspends.
 *
 * At least 1 always, since the reservation happens before the recipient's
 * account is known to exist.
 */
function countAtaCreations(serialized: Buffer): number {
  try {
    const tx = VersionedTransaction.deserialize(serialized);
    const message = tx.message as unknown as {
      staticAccountKeys?: PublicKey[];
      compiledInstructions?: { programIdIndex: number }[];
    };
    const keys = message.staticAccountKeys ?? [];
    const found = (message.compiledInstructions ?? []).filter((ix) =>
      keys[ix.programIdIndex]?.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
    ).length;
    return Math.max(1, found);
  } catch {
    return 1;
  }
}

function actualCostLamports(signedTx: Buffer): bigint {
  let signatures = 2n;
  let ataCreations = 0;

  try {
    const tx = VersionedTransaction.deserialize(signedTx);
    signatures = BigInt(Math.max(1, tx.signatures.length));

    const message = tx.message as unknown as {
      staticAccountKeys?: PublicKey[];
      compiledInstructions?: { programIdIndex: number }[];
    };
    const keys = message.staticAccountKeys ?? [];
    // Counted, not detected. A payment with fees can create an ATA for the
    // recipient and one per fee destination, and rent is charged per account —
    // treating "any ATA creation" as "one ATA creation" would under-report the
    // real spend on exactly the transactions that cost the most.
    ataCreations = (message.compiledInstructions ?? []).filter((ix) =>
      keys[ix.programIdIndex]?.equals(ASSOCIATED_TOKEN_PROGRAM_ID),
    ).length;
  } catch {
    // Cannot parse what we just broadcast — leave the worst-case assumptions in
    // place rather than guessing low.
    return worstCaseCostLamports({ ataCreations: 1 });
  }

  return worstCaseCostLamports({
    signatures: Number(signatures),
    ataCreations,
  });
}

/**
 * Run the spend breakers over a transaction about to be co-signed.
 *
 * Returns a `BroadcastFailure` when the transaction must not proceed, or
 * `null` when it is cleared.
 *
 * Fail-closed throughout. A transaction whose value cannot be read is refused,
 * because an unvaluable transaction cannot be checked against a ceiling — and
 * "we could not tell how much this moves" is not grounds to move it.
 */
async function enforceSpendPolicy(
  transaction: Buffer,
  log: Logger,
  ctx: {
    jobId: string;
    teamId: string;
    velocityStore: VelocityStore;
    notifier: AlertNotifier;
  },
): Promise<BroadcastFailure | null> {
  const raise = async (
    failure: RelayerFailure,
    alert: Omit<CircuitBreakerAlert, "code" | "detail">,
  ): Promise<BroadcastFailure> => {
    // Alerting is best-effort and must never mask the refusal it describes.
    await ctx.notifier
      .notify({ ...alert, code: failure.code, detail: failure.message })
      .catch((e) =>
        log.error(
          { err: e instanceof Error ? e.message : String(e), jobId: ctx.jobId },
          "Alert notifier threw while reporting a breaker trip",
        ),
      );
    return {
      success: false,
      retriable: false,
      message: `${failure.code}: ${failure.message}`,
      failure,
    };
  };

  const value = extractTransferValue(transaction);
  if (!value) {
    const failure = relayerFailure(
      RelayerFailureStage.PolicyCheck,
      "TRANSACTION_NOT_VALUABLE",
      "Could not determine the transfer amount from the transaction, so no spend " +
        "ceiling could be applied. Refusing rather than broadcasting an unbounded transfer.",
      false,
    );
    log.error({ jobId: ctx.jobId, teamId: ctx.teamId }, failure.message);
    return raise(failure, {
      kind: "amount_ceiling",
      intentId: ctx.jobId,
      teamId: ctx.teamId,
      amount: 0n,
      asset: null,
      decimals: null,
      threshold: 0n,
    });
  }

  const asset = value.mint?.toBase58() ?? null;

  // Decimals for alert copy only — never for the comparison, which is always on
  // the raw bigint. Read from cache rather than resolved here: a breaker trip
  // must not depend on an RPC round trip, and if the mint has not been resolved
  // yet the alert correctly reports "decimals unknown" instead of guessing.
  const decimals = asset ? cachedDecimals(asset) : null;

  // Gate 1: per-intent ceiling.
  try {
    checkSpendPolicy({ amount: value.amount, asset }, DEFAULT_AMOUNT_CEILINGS);
  } catch (e) {
    if (!(e instanceof SpendPolicyError)) throw e;
    const ceiling = DEFAULT_AMOUNT_CEILINGS.find((c) => c.asset === asset);
    return raise(e.failure, {
      kind: "amount_ceiling",
      intentId: ctx.jobId,
      teamId: ctx.teamId,
      amount: value.amount,
      asset,
      decimals,
      threshold: ceiling?.maxAmount ?? 0n,
    });
  }

  // Gate 2: velocity, global and per team. Records the broadcast only once both
  // scopes pass.
  try {
    await checkFeePayerVelocity(
      ctx.velocityStore,
      value.amount,
      asset,
      VELOCITY_WINDOW,
      ctx.teamId,
    );
  } catch (e) {
    if (!(e instanceof SpendPolicyError)) throw e;
    // Report the threshold from the scope that actually tripped, so the alert
    // states the limit that was crossed rather than the global one by default.
    // A team-scoped code means the per-team cap bound; anything else is global.
    const isTeamScoped =
      e.failure.code === "TEAM_VALUE_LIMIT" || e.failure.code === "TEAM_COUNT_LIMIT";
    const caps = isTeamScoped ? VELOCITY_WINDOW.perTeam : VELOCITY_WINDOW.global;
    return raise(e.failure, {
      kind: "fee_payer_velocity",
      intentId: ctx.jobId,
      teamId: ctx.teamId,
      amount: value.amount,
      asset,
      decimals,
      threshold: asset ? (caps.maxValuePerAsset.get(asset) ?? 0n) : 0n,
    });
  }

  return null;
}

export interface BroadcastResult {
  success: true;
  signature: string;
  rpcEndpoint: string;
}

export interface BroadcastFailure {
  success: false;
  retriable: boolean;
  message: string;
  rpcEndpoint?: string;
  failure?: RelayerFailure;
  /**
   * Seconds until this is worth retrying, when the failure is a deferral rather
   * than a defect. Set only by the SOL budget path — the caller uses it to
   * reschedule instead of consuming a retry attempt.
   */
  retryAfterSeconds?: number;
}

/**
 * Process an intent envelope by co-signing as fee payer and broadcasting.
 *
 * The caller (worker) extracts the partially-signed transaction and the
 * validated intent envelope from the job payload. This function:
 *
 *   1. Deserializes the user's partially-signed VersionedTransaction
 *   2. Calls coSignAsFeePayer() which enforces the verify-then-sign gate
 *      (steps 1-9 in feePayer.ts — user sig MUST verify before co-sign)
 *   3. Broadcasts the fully-signed transaction with RPC failover
 *
 * Unlike the v1 delegate-authority model, this function NEVER constructs
 * transaction instructions. The user supplies the fully-formed transaction;
 * the relayer only co-signs as fee payer and broadcasts.
 */
export async function processIntentAndBroadcast(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  config: Config,
  log: Logger,
  /**
   * Spend-policy context. Optional so existing callers keep working, but when
   * omitted the breakers do not run — pass it from the worker.
   */
  policy?: {
    jobId: string;
    teamId: string;
    velocityStore: VelocityStore;
    notifier: AlertNotifier;
    /**
     * Rolling SOL budget. Optional so the value-only gates can run without it,
     * but omitting it in production leaves fee-payer drain unbounded for any
     * token with no configured value ceiling.
     */
    solBudgetStore?: SolBudgetStore;
  },
): Promise<BroadcastResult | BroadcastFailure> {
  // Held across the whole function so the finally block can release or
  // reconcile it regardless of which path the transaction takes.
  let reservationId: string | null = null;
  let reservedLamports = 0n;
  let settledCost: bigint | null = null;

  try {
    // Step A: Recover the accepted fee-payer key set from config.
    // A parse failure is fatal rather than degrading to a partial set: a
    // missing legacy key would silently strand exactly the in-flight
    // transactions it exists to rescue.
    let feePayerKeys: ReturnType<typeof loadFeePayerKeypairs>;
    try {
      feePayerKeys = loadFeePayerKeypairs(config);
    } catch {
      return {
        success: false,
        retriable: false,
        message: "FEE_PAYER_KEY_INVALID: Failed to parse fee payer secret key from config",
      };
    }

    // Step A2: Spend policy (HARD GATE, fail-closed)
    //
    // Deliberately ahead of co-signing. Refusing after we have signed would
    // leave a fully-signed transaction we then decline to send — recoverable by
    // anyone who obtains the bytes, and pointless work. Nothing is signed until
    // the amount and velocity have both been cleared.
    if (policy) {
      const policyOutcome = await enforceSpendPolicy(
        partiallySignedTx,
        log,
        policy,
      );
      if (policyOutcome) return policyOutcome;
    }

    // Step A3: Reserve worst-case SOL before signing (HARD GATE, fail-closed)
    //
    // Pessimistic: assumes two signatures and that the recipient's ATA must be
    // created, because the true cost is unknowable until the transaction
    // settles. Under-reserving would let concurrent workers each see headroom
    // that is not there and collectively overspend — a check-then-act race
    // where the resource is money.
    //
    // Also ahead of co-signing, for the same reason as the spend policy.
    if (policy?.solBudgetStore) {
      reservedLamports = worstCaseCostLamports({
        // ATA existence is not checked here — doing so is an RPC round trip on
        // the broadcast path, and assuming creation is the safe direction.
        //
        // The count comes from the transaction itself: a payment with fees can
        // create one ATA per destination, and rent is charged per account. A
        // fixed 1 here would under-reserve every multi-party payment, which is
        // the check-then-act race described above with a smaller number.
        ataCreations: countAtaCreations(partiallySignedTx),
      });

      try {
        reservationId = await reserveSolSpend(
          policy.solBudgetStore,
          {
            teamId: policy.teamId,
            lamports: reservedLamports,
            reservationId: `${policy.jobId}:${randomUUID()}`,
          },
          SOL_BUDGET,
        );
      } catch (e) {
        if (e instanceof SolBudgetExceededError || e instanceof SolBudgetUnavailableError) {
          // Retriable by construction: the transaction is not defective, the
          // relayer is temporarily out of budget or cannot read it. The queue
          // should back off and try again once the window rolls, rather than
          // discarding legitimate work.
          const retryAfter =
            e instanceof SolBudgetExceededError ? e.retryAfterSeconds : undefined;

          log.warn(
            {
              jobId: policy.jobId,
              teamId: policy.teamId,
              code: e.failure.code,
              retryAfterSeconds: retryAfter,
              reservedLamports: reservedLamports.toString(),
            },
            "SOL budget refused a broadcast — will retry once budget frees",
          );

          if (e instanceof SolBudgetExceededError) {
            await policy.notifier
              .notify({
                kind: "sol_budget",
                code: e.failure.code,
                intentId: policy.jobId,
                teamId: policy.teamId,
                amount: reservedLamports,
                asset: null,
                decimals: 9, // lamports are SOL's base unit
                threshold:
                  e.breach === "global"
                    ? SOL_BUDGET.globalMaxLamports
                    : SOL_BUDGET.perTeamMaxLamports,
                detail: e.message,
              })
              .catch((err) =>
                log.error(
                  { err: err instanceof Error ? err.message : String(err) },
                  "Alert notifier threw while reporting a SOL budget trip",
                ),
              );
          }

          return {
            success: false,
            retriable: true,
            message: `${e.failure.code}: ${e.message}`,
            failure: e.failure,
            // Exact for a budget breach (when the window frees), short for a
            // store outage (which may clear in seconds and should not wait an
            // hour for a Redis reconnect).
            retryAfterSeconds:
              e instanceof SolBudgetExceededError
                ? e.retryAfterSeconds
                : SOL_BUDGET_STORE_RETRY_SECONDS,
          };
        }
        throw e;
      }
    }

    // Step B: Co-sign with verify-then-sign gate (HARD GATE)
    // If the user's signature is invalid, or the named fee payer is not one we
    // hold, or the instructions don't match the declared intent, or the
    // blockhash is missing — this returns { ok: false } and we never reach the
    // broadcast step.
    const coSignResult = coSignAsFeePayerWithKeys(
      partiallySignedTx,
      intentEnvelope,
      feePayerKeys.keypairs,
    );

    if (coSignResult.ok && coSignResult.feePayer !== feePayerKeys.primary.publicKey.toBase58()) {
      // Observability for rotation: a transaction settled against a legacy key
      // means clients are still building against it, so the old key cannot be
      // retired yet. Silence here is what makes a rotation look finished early.
      log.info(
        { feePayer: coSignResult.feePayer, primary: feePayerKeys.primary.publicKey.toBase58() },
        "Co-signed with a legacy fee payer — rotation still draining",
      );
    }

    if (!coSignResult.ok) {
      log.warn(
        {
          stage: coSignResult.failure.stage,
          code: coSignResult.failure.code,
          message: coSignResult.failure.message,
        },
        "Fee-payer co-sign rejected",
      );
      return {
        success: false,
        retriable: coSignResult.failure.retriable,
        message: `${coSignResult.failure.code}: ${coSignResult.failure.message}`,
        failure: coSignResult.failure,
      };
    }

    // Step C: Broadcast with failover
    const result = await broadcastWithFailover(coSignResult.tx, config, log);

    if (result.success) {
      // The transaction landed. Its real cost is the signature fees — the ATA
      // rent was only owed if an account was actually created, which the
      // instruction set determines. Reconciling to the observed cost returns
      // the over-reserved remainder to the window.
      //
      // Counting the signatures on the co-signed transaction is exact; whether
      // an ATA was created is inferred from the instructions, since querying
      // the chain post-hoc would be another RPC round trip for a bookkeeping
      // figure.
      settledCost = actualCostLamports(coSignResult.tx);
    }

    return result;
  } catch (e) {
    return {
      success: false,
      retriable: false,
      message: e instanceof Error ? e.message : String(e),
    };
  } finally {
    // Settle the reservation on every exit path, including thrown errors.
    //
    // Three outcomes:
    //   - broadcast succeeded  → reconcile down to the observed cost
    //   - broadcast failed     → release; nothing was spent
    //   - error before signing → release; nothing was spent
    //
    // Neither call throws. A transaction that already landed must not be
    // reported as failed because a bookkeeping write did not stick, and an
    // un-released reservation merely over-counts spend until the window rolls —
    // conservative, not dangerous.
    if (reservationId && policy?.solBudgetStore) {
      const store = policy.solBudgetStore;
      const id = reservationId;
      const onError = (reason: string) =>
        log.error(
          { jobId: policy.jobId, reservationId: id, reason },
          "SOL budget bookkeeping failed — reservation left at worst case until the window rolls",
        );

      if (settledCost !== null) {
        await reconcileSolSpend(store, id, settledCost, onError);
        log.debug(
          {
            jobId: policy.jobId,
            reservedLamports: reservedLamports.toString(),
            settledLamports: settledCost.toString(),
          },
          "SOL reservation reconciled",
        );
      } else {
        await releaseSolReservation(store, id, onError);
      }
    }
  }
}

/**
 * Settle a legacy intent bundle: build the transaction, then broadcast it.
 *
 * The legacy path carries no transaction — `payload` is the signed intent JSON
 * itself. Before this existed the worker failed every such job with
 * MISSING_INTENT_ENVELOPE, so a zypp-pay payment was accepted by the API (202,
 * with a jobId) and then silently dropped. That is the whole of C2.
 *
 * The gates run in the same order as {@link processIntentAndBroadcast} and for
 * the same reason: value and velocity are cleared *before* anything is signed,
 * because a refusal after signing leaves recoverable bytes behind. The
 * construction-specific gates (delegation, outbound reconciliation) live inside
 * `constructAndSignSettlement`, which signs nothing until they pass.
 *
 * The SOL reservation is taken from the *constructed* transaction's real ATA
 * count rather than a guess, since by then the transaction exists.
 */
export async function settleLegacyIntent(
  payload: Buffer,
  config: Config,
  log: Logger,
  policy?: {
    jobId: string;
    teamId: string;
    velocityStore: VelocityStore;
    notifier: AlertNotifier;
    solBudgetStore?: SolBudgetStore;
  },
): Promise<BroadcastResult | BroadcastFailure> {
  const asFailure = (failure: RelayerFailure): BroadcastFailure => ({
    success: false,
    retriable: failure.retriable ?? false,
    message: `${failure.code}: ${failure.message}`,
    failure,
  });

  // The bundle was already validated at ingress, including the user's signature
  // over the canonical intent hash. Re-parsing rather than trusting a cached
  // shape keeps this function honest about its input: it reads the same bytes
  // the signature covered.
  const parsed = parseIntentPayload(payload);
  if (!parsed.ok) {
    return asFailure(
      relayerFailure(RelayerFailureStage.Validation, parsed.code, parsed.message),
    );
  }

  const intent = parsed.bundle.intent;
  if (!isTransferIntent(intent)) {
    // Not a transfer — there is nothing to settle and no amount to move. It
    // reaches the queue only because ingress accepts the shape.
    return asFailure(
      relayerFailure(
        RelayerFailureStage.Validation,
        "INTENT_NOT_SETTLEABLE",
        "USDC_INITIALIZATION intents carry no transfer to settle.",
      ),
    );
  }

  let keys: { delegate: Keypair; feePayer: Keypair };
  try {
    keys = {
      delegate: loadDelegateKeypair(config),
      feePayer: loadFeePayerKeypairs(config).primary,
    };
  } catch (e) {
    // Fatal and not retriable: a missing or malformed delegate key is a
    // deployment error, and every job would fail identically until it is fixed.
    return asFailure(
      relayerFailure(
        RelayerFailureStage.Validation,
        "SETTLEMENT_KEY_INVALID",
        e instanceof Error ? e.message : "Failed to load settlement keys from config",
      ),
    );
  }

  const mint = config.USDC_MINT_ADDRESS;
  if (!mint) {
    return asFailure(
      relayerFailure(
        RelayerFailureStage.Validation,
        "MINT_NOT_CONFIGURED",
        "USDC_MINT_ADDRESS is unset, so the mint the intent refers to cannot be resolved.",
      ),
    );
  }

  // Decimals come from the chain, not a constant: converting with the wrong
  // scale moves the wrong amount by a factor of ten per digit.
  const connection = new Connection(config.RPC_URLS[0], {
    commitment: config.RPC_CONFIRMATION_COMMITMENT as Commitment,
  });

  let decimals: number;
  try {
    decimals = (await resolveMint(connection, new PublicKey(mint))).decimals;
  } catch (e) {
    // Retriable: an RPC that cannot answer now may answer shortly, and the
    // intent is not defective.
    return {
      success: false,
      retriable: true,
      message: `MINT_DECIMALS_UNAVAILABLE: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  let terms: SettlementTerms;
  try {
    terms = {
      sender: intent.sender,
      recipient: intent.receiver,
      mint,
      amount: toBaseUnits(intent.amount, decimals),
      // `intent.fee` is the fee the user signed for. It is settled to the
      // relayer's own account in the same transaction, which is why the
      // delegation check has to cover payment + fees rather than the payment.
      fees:
        intent.fee > 0
          ? [
            {
              destination: keys.feePayer.publicKey.toBase58(),
              amount: toBaseUnits(intent.fee, decimals),
            },
          ]
          : [],
    };
  } catch (e) {
    return asFailure(
      relayerFailure(
        RelayerFailureStage.Validation,
        "AMOUNT_NOT_CONVERTIBLE",
        e instanceof Error ? e.message : "Intent amount could not be converted to base units",
      ),
    );
  }

  const constructed = await constructAndSignSettlement(
    connection,
    terms,
    keys.delegate,
    keys.feePayer,
    log,
  );
  if (!constructed.ok) return asFailure(constructed.failure);

  // Value and velocity, on the constructed bytes. After construction because
  // these read the transfer set out of the transaction, but still before
  // broadcast — and construction alone commits nothing.
  if (policy) {
    const policyOutcome = await enforceSpendPolicy(constructed.transaction, log, policy);
    if (policyOutcome) return policyOutcome;
  }

  let reservationId: string | null = null;
  let reservedLamports = 0n;
  let settledCost: bigint | null = null;

  try {
    if (policy?.solBudgetStore) {
      // Exact rather than pessimistic: the transaction is built, so the ATA
      // count is known instead of assumed.
      reservedLamports = worstCaseCostLamports({ ataCreations: constructed.ataCreations });
      try {
        reservationId = await reserveSolSpend(
          policy.solBudgetStore,
          {
            teamId: policy.teamId,
            lamports: reservedLamports,
            reservationId: `${policy.jobId}:${randomUUID()}`,
          },
          SOL_BUDGET,
        );
      } catch (e) {
        if (e instanceof SolBudgetExceededError || e instanceof SolBudgetUnavailableError) {
          const retryAfter =
            e instanceof SolBudgetExceededError ? e.retryAfterSeconds : undefined;
          log.warn(
            {
              jobId: policy.jobId,
              teamId: policy.teamId,
              code: e.failure.code,
              retryAfterSeconds: retryAfter,
            },
            "SOL budget refused a settlement — will retry once budget frees",
          );
          return {
            success: false,
            retriable: true,
            message: `${e.failure.code}: ${e.failure.message}`,
            failure: e.failure,
            retryAfterSeconds: retryAfter ?? SOL_BUDGET_STORE_RETRY_SECONDS,
          };
        }
        throw e;
      }
    }

    const result = await broadcastWithFailover(constructed.transaction, config, log);
    if (result.success) {
      settledCost = actualCostLamports(constructed.transaction);
    }
    return result;
  } finally {
    if (reservationId && policy?.solBudgetStore) {
      const store = policy.solBudgetStore;
      const id = reservationId;
      const onError = (e: unknown) =>
        log.error(
          { err: e instanceof Error ? e.message : String(e), jobId: policy.jobId },
          "Failed to settle SOL reservation — budget may over-count until the window rolls",
        );

      if (settledCost === null) {
        await releaseSolReservation(store, id).catch(onError);
      } else {
        await reconcileSolSpend(store, id, settledCost, onError);
      }
      log.debug(
        {
          jobId: policy.jobId,
          reservedLamports: reservedLamports.toString(),
          settledLamports: settledCost?.toString() ?? "released",
        },
        "SOL reservation settled",
      );
    }
  }
}

export async function broadcastWithFailover(
  payload: Buffer,
  config: Config,
  log: Logger,
): Promise<BroadcastResult | BroadcastFailure> {
  const endpoints = config.RPC_URLS;
  const commitment = config.RPC_CONFIRMATION_COMMITMENT as Commitment;
  const timeout = config.RPC_CONFIRMATION_TIMEOUT_MS;

  let lastError: Error | null = null;
  let lastEndpoint: string | undefined;

  for (const endpoint of endpoints) {
    try {
      const result = await tryBroadcastOne(
        endpoint,
        payload,
        commitment,
        timeout,
        log,
      );
      if (result.success) return result;
      if (!result.retriable) return result;
      lastError = new Error(result.message);
      lastEndpoint = result.rpcEndpoint ?? endpoint;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      lastEndpoint = endpoint;
      const category = classifyError(e);
      if (category === "permanent") {
        return {
          success: false,
          retriable: false,
          message: lastError.message,
          rpcEndpoint: endpoint,
          failure: relayerFailure(
            RelayerFailureStage.Broadcast,
            "BROADCAST_PERMANENT",
            lastError.message,
          ),
        };
      }
      log.warn({ err: e, endpoint }, "RPC attempt failed, trying next");
    }
  }

  const allFailedMsg = lastError?.message ?? "All RPC endpoints failed";
  return {
    success: false,
    retriable: true,
    message: allFailedMsg,
    rpcEndpoint: lastEndpoint,
    failure: relayerFailure(
      RelayerFailureStage.Broadcast,
      "ALL_RPCS_FAILED",
      allFailedMsg,
      true,
    ),
  };
}

async function tryBroadcastOne(
  endpoint: string,
  payload: Buffer,
  commitment: Commitment,
  timeoutMs: number,
  log: Logger,
): Promise<BroadcastResult | BroadcastFailure> {
  const connection = new Connection(endpoint, { commitment });

  let rawSig: string;
  try {
    rawSig = await connection.sendRawTransaction(payload, {
      skipPreflight: false,
      preflightCommitment: commitment,
      maxRetries: 0,
    } as SendOptions);
  } catch (e) {
    const category = classifyError(e);
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      retriable: category === "retriable",
      message,
      rpcEndpoint: endpoint,
      failure: relayerFailure(
        RelayerFailureStage.Broadcast,
        category === "retriable" ? "BROADCAST_TRANSIENT" : "BROADCAST_PERMANENT",
        message,
        category === "retriable",
      ),
    };
  }

  const signature = rawSig;
  const confirmed = await waitForConfirmation(
    connection,
    signature,
    commitment,
    timeoutMs,
    log,
  );

  if (confirmed === true) {
    log.debug({ signature, endpoint }, "Transaction confirmed");
    return { success: true, signature, rpcEndpoint: endpoint };
  }
  if (confirmed === "expired") {
    return {
      success: false,
      retriable: true,
      message: "Confirmation timed out (transaction may still land)",
      rpcEndpoint: endpoint,
      failure: relayerFailure(
        RelayerFailureStage.Confirmation,
        "CONFIRMATION_TIMEOUT",
        "Confirmation timed out (transaction may still land)",
        true,
      ),
    };
  }
  const confirmedMsg = confirmed instanceof Error ? confirmed.message : String(confirmed);
  return {
    success: false,
    retriable: classifyError(confirmed) === "retriable",
    message: confirmedMsg,
    rpcEndpoint: endpoint,
    failure: relayerFailure(
      RelayerFailureStage.Confirmation,
      "CONFIRMATION_FAILED",
      confirmedMsg,
      classifyError(confirmed) === "retriable",
    ),
  };
}

const CONFIRM_POLL_INTERVAL_MS = 1000;

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  _commitment: Commitment,
  timeoutMs: number,
  _log: Logger,
): Promise<true | "expired" | Error> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status) {
      if (status.err) return new Error(String(status.err));
      const conf = status.confirmationStatus;
      if (conf === "confirmed" || conf === "finalized") return true;
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
  }
  return "expired";
}
