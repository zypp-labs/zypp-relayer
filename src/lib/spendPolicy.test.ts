import test from "node:test";
import assert from "node:assert/strict";
import {
  checkSpendPolicy,
  checkFeePayerVelocity,
  SpendPolicyError,
  InMemoryVelocityStore,
  type AmountCeiling,
  type VelocityConfig,
  type VelocityStore,
} from "./spendPolicy.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * Both breakers must fail closed. The tests that matter most here are not the
 * threshold arithmetic — they are the ones asserting that a *broken* check
 * blocks rather than waves the transaction through. A spend guard that opens
 * when its own store is down is worse than no guard, because it is trusted.
 */

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

const CEILINGS: AmountCeiling[] = [
  { asset: USDC, maxAmount: 1_000_000_000n }, // 1,000 USDC at 6dp
  { asset: WSOL, maxAmount: 10_000_000_000n }, // 10 SOL at 9dp
];

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";

/**
 * Global caps deliberately loose relative to per-team, so a test that trips a
 * team cap cannot be passing because the global one bound first.
 */
const VELOCITY: VelocityConfig = {
  global: {
    maxValuePerAsset: new Map([
      [USDC, 50_000_000_000n], // 50,000 USDC at 6dp
      [WSOL, 500_000_000_000n], // 500 SOL at 9dp
    ]),
    maxCountPerWindow: 100,
  },
  perTeam: {
    maxValuePerAsset: new Map([
      [USDC, 5_000_000_000n], // 5,000 USDC at 6dp
      [WSOL, 50_000_000_000n], // 50 SOL at 9dp
    ]),
    maxCountPerWindow: 10,
  },
  windowMs: 60 * 60 * 1000,
};

function expectPolicyError(fn: () => unknown, code: string) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof SpendPolicyError, `expected SpendPolicyError, got ${err}`);
    assert.equal(err.failure.code, code);
    assert.equal(err.failure.stage, RelayerFailureStage.PolicyCheck);
    assert.equal(err.failure.retriable, false, "a policy stop must not be retried");
    return true;
  });
}

async function expectAsyncPolicyError(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof SpendPolicyError, `expected SpendPolicyError, got ${err}`);
    assert.equal(err.failure.code, code);
    assert.equal(err.failure.stage, RelayerFailureStage.PolicyCheck);
    assert.equal(err.failure.retriable, false);
    return true;
  });
}

// ─── Per-intent amount ceiling ───

test("allows an amount inside the ceiling", () => {
  checkSpendPolicy({ amount: 500_000_000n, asset: USDC }, CEILINGS);
});

test("allows an amount exactly at the ceiling", () => {
  // Boundary is inclusive; refusal begins strictly above.
  checkSpendPolicy({ amount: 1_000_000_000n, asset: USDC }, CEILINGS);
});

test("REFUSES an amount one unit above the ceiling", () => {
  expectPolicyError(
    () => checkSpendPolicy({ amount: 1_000_000_001n, asset: USDC }, CEILINGS),
    "AMOUNT_EXCEEDS_CEILING",
  );
});

test("REFUSES a wildly oversized amount", () => {
  expectPolicyError(
    () => checkSpendPolicy({ amount: 10_000_000_000_000n, asset: USDC }, CEILINGS),
    "AMOUNT_EXCEEDS_CEILING",
  );
});

test("applies each asset's own ceiling", () => {
  // 5 SOL is fine under the wSOL ceiling but would blow past the USDC one —
  // proving the ceiling is per-asset, not global.
  checkSpendPolicy({ amount: 5_000_000_000n, asset: WSOL }, CEILINGS);
  expectPolicyError(
    () => checkSpendPolicy({ amount: 5_000_000_000n, asset: USDC }, CEILINGS),
    "AMOUNT_EXCEEDS_CEILING",
  );
});

test("REFUSES an asset with no configured ceiling — fail closed", () => {
  // The critical default. An unrecognised mint must not fall through to
  // "unbounded"; a missing ceiling is a config gap, not permission.
  expectPolicyError(
    () => checkSpendPolicy({ amount: 1n, asset: "SomeUnknownMint11111111111111111111111111111" }, CEILINGS),
    "NO_CEILING_CONFIGURED",
  );
});

test("REFUSES when the asset cannot be determined — fail closed", () => {
  // A bare SPL Transfer does not carry the mint as an operand, so the value
  // extractor reports null. Unvaluable means unrefusable, so it is refused.
  expectPolicyError(
    () => checkSpendPolicy({ amount: 1n, asset: null }, CEILINGS),
    "NO_CEILING_CONFIGURED",
  );
});

test("REFUSES an empty ceiling table — fail closed", () => {
  expectPolicyError(() => checkSpendPolicy({ amount: 1n, asset: USDC }, []), "NO_CEILING_CONFIGURED");
});

test("REFUSES a zero or negative amount", () => {
  expectPolicyError(() => checkSpendPolicy({ amount: 0n, asset: USDC }, CEILINGS), "NON_POSITIVE_AMOUNT");
  expectPolicyError(() => checkSpendPolicy({ amount: -1n, asset: USDC }, CEILINGS), "NON_POSITIVE_AMOUNT");
});

// ─── Fee-payer velocity ───

test("allows broadcasts below both caps", async () => {
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  await checkFeePayerVelocity(store, 1_000_000_000n, USDC, VELOCITY, TEAM_A, now);
  await checkFeePayerVelocity(store, 1_000_000_000n, USDC, VELOCITY, TEAM_A, now + 1000);
});

test("HALTS when an asset's aggregate value cap would be crossed", async () => {
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  // Four at 1,000 USDC = 4,000, under the 5,000 cap.
  for (let i = 0; i < 4; i++) {
    await checkFeePayerVelocity(store, 1_000_000_000n, USDC, VELOCITY, TEAM_A, now + i);
  }
  // A fifth would reach 5,000 exactly — still allowed.
  await checkFeePayerVelocity(store, 1_000_000_000n, USDC, VELOCITY, TEAM_A, now + 5);
  // A sixth crosses it.
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 6),
    "TEAM_VALUE_LIMIT",
  );
});

test("each asset's value cap is independent", async () => {
  // The property the per-asset refactor exists for. A shared figure would have
  // let USDC spend eat SOL's budget, in units that mean nothing in common.
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;

  // Exhaust USDC entirely.
  await checkFeePayerVelocity(store, 5_000_000_000n, USDC, VELOCITY, TEAM_A, now);
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 1),
    "TEAM_VALUE_LIMIT",
  );

  // SOL is untouched and still has its full 50 SOL budget.
  await checkFeePayerVelocity(store, 50_000_000_000n, WSOL, VELOCITY, TEAM_A, now + 2);
});

test("HALTS when the transaction count cap would be crossed", async () => {
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  // Ten tiny transactions exhaust the count cap without approaching the value cap.
  for (let i = 0; i < 10; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + i);
  }
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 11),
    "TEAM_COUNT_LIMIT",
  );
});

test("the count cap is shared across assets", async () => {
  // Splitting volume across mints must not earn a fresh count budget.
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  for (let i = 0; i < 10; i++) {
    await checkFeePayerVelocity(store, 1n, i % 2 === 0 ? USDC : WSOL, VELOCITY, TEAM_A, now + i);
  }
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, WSOL, VELOCITY, TEAM_A, now + 11),
    "TEAM_COUNT_LIMIT",
  );
});

// ─── Per-team scoping ───

test("one team's spend does NOT consume another team's budget", async () => {
  // Before per-team scoping the velocity window was global, so one tenant's
  // burst halted broadcasts for every other tenant — an availability failure
  // with the same tenant-isolation shape as a cross-tenant data leak.
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;

  // Team A exhausts its own count cap.
  for (let i = 0; i < 10; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + i);
  }
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 11),
    "TEAM_COUNT_LIMIT",
  );

  // Team B is unaffected.
  await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_B, now + 12);
});

test("the GLOBAL cap still binds when every team stays inside its own", async () => {
  // Neither cap subsumes the other: many teams individually well-behaved can
  // still collectively drain the shared fee payer.
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;

  // 100 broadcasts across 20 teams — 5 each, half the per-team count cap, but
  // exactly the global cap of 100.
  for (let i = 0; i < 100; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, `team-${i % 20}`, now + i);
  }

  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, "team-fresh", now + 200),
    "FEE_PAYER_COUNT_LIMIT",
  );
});

test("global is reported before team when both are breached", async () => {
  // A platform-wide condition must not be misattributed to whichever tenant
  // arrived at the wrong moment — the same ordering rule as the SOL budget.
  const tight: VelocityConfig = {
    global: { maxValuePerAsset: new Map([[USDC, 100n]]), maxCountPerWindow: 1 },
    perTeam: { maxValuePerAsset: new Map([[USDC, 100n]]), maxCountPerWindow: 1 },
    windowMs: 60 * 60 * 1000,
  };
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;

  await checkFeePayerVelocity(store, 100n, USDC, tight, TEAM_A, now);
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 100n, USDC, tight, TEAM_A, now + 1),
    "FEE_PAYER_VALUE_LIMIT",
  );
});

test("a team breach names the team so an operator knows who to look at", async () => {
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;

  await checkFeePayerVelocity(store, 5_000_000_000n, USDC, VELOCITY, TEAM_A, now);
  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 1),
    new RegExp(TEAM_A),
  );
});

test("REFUSES an asset with no configured velocity cap — fail closed", async () => {
  const store = new InMemoryVelocityStore();
  await expectAsyncPolicyError(
    () =>
      checkFeePayerVelocity(
        store,
        1n,
        "UnlistedMint111111111111111111111111111111",
        VELOCITY,
        TEAM_A,
      ),
    "NO_VELOCITY_CAP_CONFIGURED",
  );
});

test("REFUSES when the asset is unknown — fail closed", async () => {
  // A bare SPL Transfer carries no mint. Uncappable means refused, not allowed.
  const store = new InMemoryVelocityStore();
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, null, VELOCITY, TEAM_A),
    "NO_VELOCITY_CAP_CONFIGURED",
  );
});

test("does not record a broadcast that was refused", async () => {
  // A blocked attempt must not consume window budget, or repeated blocked
  // attempts would compound into a longer outage than the breach warrants.
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  for (let i = 0; i < 10; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + i);
  }
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + 11),
    "TEAM_COUNT_LIMIT",
  );
  const w = await store.teamWindow(TEAM_A, now + 12, VELOCITY.windowMs);
  assert.equal(w.count, 10, "the refused attempt must not have been recorded");
});

test("the window rolls — old broadcasts stop counting", async () => {
  const store = new InMemoryVelocityStore();
  const now = 1_800_000_000_000;
  for (let i = 0; i < 10; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, now + i);
  }
  // Just past the window, the earlier ten have aged out.
  const later = now + VELOCITY.windowMs + 1;
  await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, later);
});

// ─── Fail-closed on store failure ───

/** A store whose reads always fail. */
const readBrokenStore: VelocityStore = {
  async record() {},
  async teamWindow() {
    throw new Error("redis connection refused");
  },
  async globalWindow() {
    throw new Error("redis connection refused");
  },
};

/** A store that reads fine but cannot persist. */
const writeBrokenStore: VelocityStore = {
  async record() {
    throw new Error("redis write timeout");
  },
  async teamWindow() {
    return { valueByAsset: new Map(), count: 0 };
  },
  async globalWindow() {
    return { valueByAsset: new Map(), count: 0 };
  },
};

test("BLOCKS when the velocity store cannot be read — fail closed", async () => {
  // The single most important test in this file. If the store is unreachable
  // the relayer has no idea how much it has already spent, so it must stop.
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(readBrokenStore, 1n, USDC, VELOCITY, TEAM_A),
    "VELOCITY_STORE_UNAVAILABLE",
  );
});

test("BLOCKS when the velocity store cannot be written — fail closed", async () => {
  // If the broadcast cannot be recorded it would be invisible to every
  // subsequent check, so the cap would silently stop binding.
  await expectAsyncPolicyError(
    () => checkFeePayerVelocity(writeBrokenStore, 1n, USDC, VELOCITY, TEAM_A),
    "VELOCITY_STORE_WRITE_FAILED",
  );
});

test("store failure surfaces the underlying cause for investigation", async () => {
  await assert.rejects(
    () => checkFeePayerVelocity(readBrokenStore, 1n, USDC, VELOCITY, TEAM_A),
    /redis connection refused/,
  );
});
