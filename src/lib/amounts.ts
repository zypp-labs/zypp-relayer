/**
 * Convert a UI-unit decimal amount into base units, exactly.
 *
 * ## Why this is not `amount * 10 ** decimals`
 *
 * The legacy intent schema carries `amount`, `fee`, and `total` as JSON numbers
 * — so by the time they reach here they are IEEE-754 doubles. Multiplying a
 * double by a power of ten does not produce the integer it looks like:
 *
 *   0.07 * 100           → 7.000000000000001
 *   0.29 * 100           → 28.999999999999996   ← truncates to 28
 *
 * The second shape is the dangerous one: a value one base unit *short* of what
 * the user agreed to. The error is not uniform — it depends on the specific
 * binary representation, so it appears on particular amounts in production and
 * on none of the round numbers a test would naturally reach for. Which values
 * fail is not worth memorising; `amounts.test.ts` searches for them at runtime
 * rather than trusting a hardcoded list.
 *
 * The fix is to never let the decimal point exist as arithmetic. Take the
 * number's decimal *string*, move the point by shifting digits, and parse the
 * result as a BigInt. No floating-point operation touches the value.
 *
 * ## Why the input is still a number
 *
 * Because the wire format says so. `validate.ts` types these fields
 * `z.number()`, and changing that breaks every already-signed intent — the
 * canonical intent ID hashes the JSON, so altering the encoding changes the
 * hash. The right place to fix the representation is the v2 schema (fee entries
 * already cross the FFI as decimal strings for exactly this reason). Until
 * then, this function is the boundary where a lossy representation becomes an
 * exact one, and it refuses anything it cannot convert faithfully.
 */

/** Raised when a UI amount cannot be represented exactly in base units. */
export class AmountConversionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountConversionError";
  }
}

/**
 * Convert `amount` (UI units) to base units for a mint with `decimals` places.
 *
 * @throws {AmountConversionError} if the value is not finite, is negative, has
 * more decimal places than the mint supports, or has already lost precision as
 * a double before reaching here.
 */
export function toBaseUnits(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount)) {
    throw new AmountConversionError(`Amount must be finite, got ${amount}`);
  }
  if (amount < 0) {
    throw new AmountConversionError(`Amount must not be negative, got ${amount}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new AmountConversionError(
      `Mint decimals must be an integer in 0..18, got ${decimals}`,
    );
  }

  const [whole, fraction] = plainDecimalParts(amount);

  if (fraction.length > decimals) {
    throw new AmountConversionError(
      `Amount ${amount} has ${fraction.length} decimal places but the mint supports only ` +
        `${decimals}. Rounding here would move a different amount than the user agreed to.`,
    );
  }

  // Shift the decimal point by padding, then parse as an integer. No
  // floating-point arithmetic is involved, so nothing can drift.
  const units = BigInt(whole + fraction.padEnd(decimals, "0"));

  // SPL token amounts are u64. A value above that cannot be encoded at all, and
  // the instruction builder would either throw deep in serialisation or wrap —
  // so bound it here, where the number still has context.
  if (units > U64_MAX) {
    throw new AmountConversionError(
      `Amount ${amount} is ${units} base units, which exceeds the u64 maximum SPL token ` +
        `amounts can carry (${U64_MAX}).`,
    );
  }

  return units;
}

/** Largest value an SPL token amount can hold. */
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Split a number into `[wholeDigits, fractionDigits]`, expanding exponential
 * notation rather than choking on it.
 *
 * `toString()` is the right source — it returns the shortest decimal string that
 * round-trips to the same double, which recovers the value the client *meant*
 * rather than the double's full binary expansion. Using `toFixed(20)` instead
 * would surface that expansion and reject `1.1` as over-precise.
 *
 * But `toString()` switches to exponential form below 1e-6 and at/above 1e21,
 * and the small end is not an edge case: on a 9-decimal mint every amount under
 * `0.000001` stringifies that way, including `1e-9`, which is exactly one base
 * unit. Refusing those would refuse the smallest legitimate payment the mint
 * supports. So the exponent is applied by moving digits, which is exact.
 */
function plainDecimalParts(amount: number): [string, string] {
  const text = amount.toString();
  const match = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) {
    // Unreachable for finite non-negative input, which the caller has already
    // established. Throwing beats returning something plausible-looking.
    throw new AmountConversionError(`Could not parse '${text}' as a decimal amount`);
  }

  const [, whole, fraction = "", exponent] = match;
  if (!exponent) return [whole, fraction];

  const digits = whole + fraction;
  // The point currently sits after `whole.length` digits; the exponent moves it.
  const pointAt = whole.length + Number(exponent);

  if (pointAt <= 0) return ["0", "0".repeat(-pointAt) + digits];
  if (pointAt >= digits.length) return [digits + "0".repeat(pointAt - digits.length), ""];
  return [digits.slice(0, pointAt), digits.slice(pointAt)];
}

/**
 * Convert base units back to a UI-unit decimal string.
 *
 * Returns a **string**, never a number: the round trip through a double is what
 * this module exists to avoid, and handing back a number would reintroduce it
 * one call later. For display and logging only.
 */
export function fromBaseUnits(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new AmountConversionError(
      `Mint decimals must be an integer in 0..18, got ${decimals}`,
    );
  }
  if (decimals === 0) return units.toString();

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");

  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
