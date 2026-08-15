import test from "node:test";
import assert from "node:assert/strict";
import { toBaseUnits, fromBaseUnits, AmountConversionError } from "./amounts.js";

/**
 * Unit conversion, which is where money quietly goes missing.
 *
 * The legacy intent schema carries amounts as JSON numbers, so they arrive as
 * doubles. `amount * 10 ** decimals` on a double does not produce the integer
 * it appears to — and the error depends on the value, so it shows up in
 * production on particular amounts and never in a test using round numbers.
 *
 * These tests pin the cases where the naive multiplication is provably wrong.
 */

/**
 * Find UI amounts the naive `ui * 10 ** decimals` gets wrong.
 *
 * Searched rather than hardcoded, deliberately. Which values fail depends on
 * binary representation, and an earlier version of this test asserted failures
 * from memory that turned out not to be failures at all (8.7 * 1e6 is exactly
 * 8700000). A search cannot be wrong about its own premise.
 */
function naiveFailures(decimals: number, limit: number): number[] {
  const scale = 10 ** decimals;
  const found: number[] = [];
  // Two-decimal amounts across a realistic payment range — the shape a price or
  // a fee actually takes.
  for (let cents = 1; cents <= 200_000 && found.length < limit; cents++) {
    const ui = cents / 100;
    if (Math.trunc(ui * scale) !== Math.round(ui * scale)) found.push(ui);
  }
  return found;
}

test("the naive multiplication really is wrong — searched, not assumed", () => {
  // Guards the premise of the whole module. If this finds nothing, the string
  // path is solving a problem that does not exist and should be reconsidered.
  const failures = naiveFailures(6, 5);
  assert.ok(
    failures.length > 0,
    "Expected float multiplication to truncate low on some two-decimal amount",
  );
});

test("every amount the naive path gets wrong, this path gets right", () => {
  // The payoff: for each value where truncation loses a base unit, the exact
  // conversion returns the integer the decimal string implies.
  for (const ui of naiveFailures(6, 40)) {
    const expected = BigInt(Math.round(ui * 1e6));
    assert.equal(toBaseUnits(ui, 6), expected, `${ui} converted incorrectly`);
    assert.notEqual(
      toBaseUnits(ui, 6),
      BigInt(Math.trunc(ui * 1e6)),
      `${ui} should differ from the truncated float result`,
    );
  }
});

test("ordinary amounts convert exactly", () => {
  assert.equal(toBaseUnits(1, 6), 1_000_000n);
  assert.equal(toBaseUnits(0.01, 6), 10_000n);
  assert.equal(toBaseUnits(1000, 6), 1_000_000_000n);
  assert.equal(toBaseUnits(0.000001, 6), 1n);
});

test("zero converts to zero, not to a refusal", () => {
  // A zero *fee* is legitimate, and refusing it would block fee-free payments.
  assert.equal(toBaseUnits(0, 6), 0n);
});

test("a 0-decimal mint keeps the whole number", () => {
  // NFTs and many SPL mints are indivisible. `decimals` must not be treated as
  // truthy anywhere on this path.
  assert.equal(toBaseUnits(5, 0), 5n);
  assert.equal(toBaseUnits(0, 0), 0n);
});

test("a 9-decimal mint works as well as a 6-decimal one", () => {
  assert.equal(toBaseUnits(1.5, 9), 1_500_000_000n);
  assert.equal(toBaseUnits(0.000000001, 9), 1n);
});

// ─── refusals ───

test("REFUSES more decimal places than the mint supports", () => {
  // Rounding here would move a different amount than the user signed for. The
  // only safe answer is to decline.
  assert.throws(() => toBaseUnits(1.0000001, 6), AmountConversionError);
  assert.throws(() => toBaseUnits(0.5, 0), /decimal places/);
});

test("exponential notation is expanded, not refused", () => {
  // REGRESSION. An earlier version rejected anything `toString()` rendered
  // exponentially — but that form kicks in below 1e-6, so on a 9-decimal mint
  // it refused `1e-9`, which is one base unit: the smallest payment the mint
  // can express. Refusing the minimum denomination is not a safety property.
  assert.equal(toBaseUnits(1e-9, 9), 1n);
  assert.equal(toBaseUnits(1e-7, 9), 100n);
  assert.equal(toBaseUnits(2.5e-7, 9), 250n);
});

test("a large exponential value is expanded, then refused for exceeding u64", () => {
  // These two facts sit next to each other and are worth stating together:
  // `toString()` only switches to exponential at 1e21, and u64 tops out around
  // 1.8e19. So a *large* exponential amount is always beyond what an SPL token
  // can carry — unlike the small end, where 1e-9 is a perfectly ordinary one
  // base unit. There is no valid large-exponential case to accept.
  //
  // Asserting the expanded digits appear in the error proves the exponent was
  // applied before the bound was checked. If expansion had been skipped, "1e+21"
  // would have parsed as 1 and sailed through as one base unit — off by
  // twenty-one orders of magnitude, in the direction that moves far too much.
  assert.throws(
    () => toBaseUnits(1e21, 0),
    (e: unknown) => {
      assert.ok(e instanceof AmountConversionError, "wrong error type");
      assert.match(e.message, /1000000000000000000000/, "the exponent must be expanded first");
      assert.match(e.message, /u64/);
      return true;
    },
  );
});

test("a small exponential value still respects the mint's precision", () => {
  // Expanding must not become a way around the decimals check: 1e-9 on a
  // 6-decimal mint is three places too precise and has to be refused.
  assert.throws(() => toBaseUnits(1e-9, 6), /decimal places/);
});

test("REFUSES non-finite and negative amounts", () => {
  assert.throws(() => toBaseUnits(NaN, 6), /finite/);
  assert.throws(() => toBaseUnits(Infinity, 6), /finite/);
  assert.throws(() => toBaseUnits(-1, 6), /negative/);
});

test("REFUSES nonsense decimals", () => {
  assert.throws(() => toBaseUnits(1, 6.5), /0\.\.18/);
  assert.throws(() => toBaseUnits(1, -1), /0\.\.18/);
  assert.throws(() => toBaseUnits(1, 19), /0\.\.18/);
});

// ─── the reverse direction ───

test("base units format back to their decimal string", () => {
  assert.equal(fromBaseUnits(1_000_000n, 6), "1");
  assert.equal(fromBaseUnits(8_700_000n, 6), "8.7");
  assert.equal(fromBaseUnits(10_000n, 6), "0.01");
  assert.equal(fromBaseUnits(1n, 6), "0.000001");
  assert.equal(fromBaseUnits(0n, 6), "0");
});

test("formatting returns a string, so the value cannot drift on the way back", () => {
  // Returning a number would reintroduce the double one call later, which is
  // precisely what this module exists to prevent.
  assert.equal(typeof fromBaseUnits(8_700_000n, 6), "string");
});

test("a round trip through both directions is lossless", () => {
  for (const ui of [8.7, 1.1, 0.07, 0.29, 1.005, 4.35, 1000, 0.000001]) {
    const units = toBaseUnits(ui, 6);
    assert.equal(
      toBaseUnits(Number(fromBaseUnits(units, 6)), 6),
      units,
      `${ui} did not survive the round trip`,
    );
  }
});

test("formatting handles values beyond what a double can hold", () => {
  // Base-unit sums can exceed 2^53 even when each part is small. The bigint
  // path has to stay exact all the way to the display string.
  const huge = 9_007_199_254_740_993_000_000n; // (2^53 + 1) * 1e6
  assert.equal(fromBaseUnits(huge, 6), "9007199254740993");
});
