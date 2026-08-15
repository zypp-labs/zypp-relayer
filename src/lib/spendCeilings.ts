import type { AmountCeiling } from "./spendPolicy.js";

/**
 * Per-asset spend ceilings.
 *
 * ## Units — read before adding an asset
 *
 * Every value here is in the mint's **smallest indivisible unit**, never the
 * human-facing decimal amount. Getting this wrong does not fail loudly: writing
 * `1.2` where lamports are expected yields a ceiling of one lamport, which
 * blocks everything; writing `100` for USDC yields a ceiling of 0.0001 USDC,
 * same. The dangerous direction is the reverse — a ceiling entered in whole
 * units where base units were meant is 10^decimals too permissive, so a cap
 * intended as $100 would admit $100,000,000.
 *
 * The `BaseUnits` branded type below makes that mistake a compile error rather
 * than a production incident: a bare number will not satisfy it, so a new
 * ceiling has to go through `baseUnits()` and state its reasoning.
 *
 * ## Provisional
 *
 * These are launch defaults chosen before any real transaction volume exists to
 * calibrate against — deliberately conservative, expected to be revisited.
 *
 * TODO(2026-08-02): **revisit these against real volume before this becomes the
 * permanent default.** The database's 77 historical jobs are all development
 * traffic (see `to-be-fixed.md`), so there is no distribution to fit yet. Once
 * B2's metering collects real transactions, re-set these from observed p99 and
 * drop this marker. "Provisional" has a way of becoming permanent by default —
 * this comment is the tripwire so it does not happen silently.
 */

/**
 * An amount in a mint's smallest unit.
 *
 * Branded so a plain number cannot be passed where base units are required —
 * the whole point is that `1.2` and `1_200_000_000` are both "valid numbers"
 * and only one is a correct lamport value.
 */
export type BaseUnits = bigint & { readonly __brand: "BaseUnits" };

/**
 * Declare an amount in base units.
 *
 * @param whole    the human-facing amount, for documentation only
 * @param decimals the mint's decimal places
 * @param units    the actual base-unit value — must equal whole * 10^decimals
 *
 * Passing all three and checking them against each other is deliberate
 * redundancy: the arithmetic is done here, at author time, rather than trusted
 * to whoever reads the literal later.
 *
 * @throws if the stated whole amount and base-unit value disagree
 */
export function baseUnits(whole: number, decimals: number, units: bigint): BaseUnits {
  // Compute expected via string arithmetic — `whole * 10 ** decimals` in
  // floating point is exactly the class of error this function exists to catch
  // (1.2 * 1e9 is 1200000000.0000002).
  const [intPart, fracPart = ""] = whole.toString().split(".");
  if (fracPart.length > decimals) {
    throw new Error(
      `${whole} has ${fracPart.length} decimal places but the mint only has ${decimals}`,
    );
  }
  const expected = BigInt(intPart + fracPart.padEnd(decimals, "0"));

  if (expected !== units) {
    throw new Error(
      `ceiling mismatch: ${whole} at ${decimals} decimals is ${expected} base units, ` +
        `but ${units} was given`,
    );
  }
  return units as BaseUnits;
}

/** Mint addresses, named so a ceiling entry is readable. */
export const MINTS = {
  /** USDC, 6 decimals. */
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  /** Wrapped SOL, 9 decimals. */
  WSOL: "So11111111111111111111111111111111111111112",
} as const;

/**
 * Provisional launch ceilings. Revisit once real volume exists.
 *
 * A payment above these is **rejected permanently**. There is no manual-review
 * queue and none is planned, so nothing here should be read as "held for
 * approval" — the transaction is refused and the caller must submit a smaller
 * one.
 */
export const DEFAULT_AMOUNT_CEILINGS: AmountCeiling[] = [
  {
    asset: MINTS.USDC,
    // $100 USDC. 6 decimals → 100 * 10^6.
    maxAmount: baseUnits(100, 6, 100_000_000n),
  },
  {
    asset: MINTS.WSOL,
    // 1.2 SOL in lamports. 9 decimals → 1.2 * 10^9.
    // NOT 1.2 — that would be a ceiling of one lamport.
    maxAmount: baseUnits(1.2, 9, 1_200_000_000n),
  },
];

/** Display symbols for the mints we can name. Anything else is shown by address. */
const SYMBOLS: Record<string, string> = {
  [MINTS.USDC]: "USDC",
  [MINTS.WSOL]: "SOL",
};

/** A mint address abbreviated for log and alert copy: `EPjF…Dt1v`. */
function abbreviateMint(asset: string): string {
  return asset.length > 12 ? `${asset.slice(0, 4)}…${asset.slice(-4)}` : asset;
}

/**
 * Human-readable amount, for alert and log copy only.
 *
 * Never feed this back into a comparison — it is lossy by design. Ceilings are
 * enforced on the bigint.
 *
 * `decimals` must be supplied by the caller, resolved from the chain via
 * `resolveMint` (see `mintDecimals.ts`). It is deliberately not defaulted:
 * the previous version fell back to `0`, which is not "unknown" but a claim
 * that the token is indivisible — so `5000000` base units of a 6-decimal token
 * rendered as "5000000", five million times the real figure, in exactly the
 * alert someone would be reading during an incident.
 *
 * Pass `null` when decimals genuinely are not known. The output then says so
 * rather than implying a magnitude.
 */
export function formatBaseUnits(
  amount: bigint,
  asset: string,
  decimals: number | null,
): string {
  const label = SYMBOLS[asset] ?? abbreviateMint(asset);

  if (decimals === null) {
    // Unknown scale. State the raw figure and name the token, but make no claim
    // about how much it is worth.
    return `${amount} base units of ${label} (decimals unknown)`;
  }

  if (decimals === 0) {
    // A genuinely indivisible token, established rather than assumed.
    return `${amount} ${label}`;
  }

  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const frac = (amount % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} ${label}` : `${whole} ${label}`;
}
