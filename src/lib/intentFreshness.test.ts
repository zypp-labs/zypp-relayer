import test from "node:test";
import assert from "node:assert/strict";
import {
  checkIntentFreshness,
  DEFAULT_INTENT_MAX_AGE_SECONDS,
  INTENT_FUTURE_SKEW_SECONDS,
} from "./validateV1.js";

/**
 * C2: a payment intent is a durable record of user consent, but consent goes
 * stale. The transaction that settles it is built at sync time (a Solana
 * blockhash lives ~60–90s and cannot survive a queue), so the intent's own age
 * is the only thing the relayer can judge.
 *
 * Before this check, a stale intent consumed a credit, failed at broadcast
 * with "blockhash not found", and burned every retry against a condition that
 * could never succeed. These tests pin the boundaries of the replacement.
 */

const NOW = 1_800_000_000; // fixed clock; no dependence on wall time

test("intent with no issuedAt is accepted", () => {
  // Clients built before timestamping cannot report age. Rejecting them would
  // break every pre-upgrade install, so the check is advisory on that path.
  assert.deepEqual(checkIntentFreshness(undefined, NOW), { fresh: true });
});

test("intent issued moments ago is fresh", () => {
  assert.deepEqual(checkIntentFreshness(NOW - 30, NOW), { fresh: true });
});

test("intent just inside the age limit is fresh", () => {
  const issuedAt = NOW - DEFAULT_INTENT_MAX_AGE_SECONDS + 1;
  assert.deepEqual(checkIntentFreshness(issuedAt, NOW), { fresh: true });
});

test("intent exactly at the age limit is fresh", () => {
  // Boundary is inclusive: expiry triggers strictly past the limit.
  const issuedAt = NOW - DEFAULT_INTENT_MAX_AGE_SECONDS;
  assert.deepEqual(checkIntentFreshness(issuedAt, NOW), { fresh: true });
});

test("intent one second past the limit expires", () => {
  const issuedAt = NOW - DEFAULT_INTENT_MAX_AGE_SECONDS - 1;
  const result = checkIntentFreshness(issuedAt, NOW);
  assert.equal(result.fresh, false);
  if (result.fresh) return;
  assert.equal(result.code, "INTENT_EXPIRED");
  assert.match(result.message, /120-day limit/);
});

test("expired intent message states the actual age", () => {
  // Comfortably past the 120-day limit.
  const issuedAt = NOW - 200 * 24 * 60 * 60;
  const result = checkIntentFreshness(issuedAt, NOW);
  assert.equal(result.fresh, false);
  if (result.fresh) return;
  assert.match(result.message, /queued 200 day\(s\) ago/);
  // The developer needs to know the remedy, not just the rejection.
  assert.match(result.message, /Re-confirm the payment/);
});

test("small clock skew forward is tolerated", () => {
  // Phone clocks drift. A device a minute fast must not have every intent
  // rejected as issued in the future.
  const issuedAt = NOW + 60;
  assert.deepEqual(checkIntentFreshness(issuedAt, NOW), { fresh: true });
});

test("skew exactly at the allowance is tolerated", () => {
  const issuedAt = NOW + INTENT_FUTURE_SKEW_SECONDS;
  assert.deepEqual(checkIntentFreshness(issuedAt, NOW), { fresh: true });
});

test("timestamp far in the future is rejected", () => {
  const issuedAt = NOW + INTENT_FUTURE_SKEW_SECONDS + 60;
  const result = checkIntentFreshness(issuedAt, NOW);
  assert.equal(result.fresh, false);
  if (result.fresh) return;
  assert.equal(result.code, "INTENT_ISSUED_IN_FUTURE");
  assert.match(result.message, /device clock/);
});

test("custom max age is honoured", () => {
  const oneHour = 60 * 60;
  assert.deepEqual(checkIntentFreshness(NOW - oneHour + 1, NOW, oneHour), { fresh: true });

  const result = checkIntentFreshness(NOW - oneHour - 1, NOW, oneHour);
  assert.equal(result.fresh, false);
});

test("default age limit is 120 days", () => {
  // Deliberately long: the transaction settling an intent is built fresh at
  // sync time, so blockhash expiry does not bound how long an intent may wait.
  // What remains bounded is consent — the authorization stays finite rather
  // than standing indefinitely. Pinned so a change is deliberate.
  assert.equal(DEFAULT_INTENT_MAX_AGE_SECONDS, 10_368_000);
});
