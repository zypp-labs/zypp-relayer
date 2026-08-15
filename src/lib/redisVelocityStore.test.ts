import test from "node:test";
import assert from "node:assert/strict";
import {
  RedisVelocityStore,
  sumVelocityMembers,
  type RedisLike,
} from "./redisVelocityStore.js";
import { checkFeePayerVelocity, SpendPolicyError, type VelocityConfig } from "./spendPolicy.js";

/**
 * Redis-backed velocity window, per asset and per team.
 *
 * Three properties matter here and none is optional:
 *
 * 1. **Durability.** The in-memory store made the breaker bypassable by restart
 *    — and hosts restart on deploy, on scaling, and on idle suspension, so the
 *    window was being forgotten routinely, not just adversarially.
 * 2. **Per-asset separation.** Base units are not comparable across mints, so a
 *    shared total is denominated in nothing. Each asset's spend must be tracked
 *    and capped against its own budget.
 * 3. **Per-team separation.** A single global window is a shared budget that the
 *    busiest tenant consumes on everyone's behalf — one team's burst halted
 *    broadcasts for every other team. Each tenant needs its own allowance, with
 *    the global cap retained on top for platform-wide conditions.
 */

const PREFIX = "test:velocity";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";

/**
 * Global caps are deliberately loose relative to per-team here, so a test that
 * trips a team cap cannot be passing for the wrong reason.
 */
const VELOCITY: VelocityConfig = {
  global: {
    maxValuePerAsset: new Map([
      [USDC, 10_000n],
      [WSOL, 50_000n],
    ]),
    maxCountPerWindow: 20,
  },
  perTeam: {
    maxValuePerAsset: new Map([
      [USDC, 1_000n],
      [WSOL, 5_000n],
    ]),
    maxCountPerWindow: 5,
  },
  windowMs: 60_000,
};

/**
 * In-process sorted sets with the semantics this store relies on.
 *
 * Keyed, unlike the previous fake: the store now writes a team key and a global
 * key, and a fake that ignored the key would make the two indistinguishable —
 * exactly the property under test.
 */
function fakeRedis() {
  const sets = new Map<string, { score: number; member: string }[]>();
  const calls: string[] = [];

  const entriesFor = (key: string) => {
    let e = sets.get(key);
    if (!e) {
      e = [];
      sets.set(key, e);
    }
    return e;
  };

  const redis: RedisLike = {
    async zadd(key, score, member) {
      calls.push("zadd");
      const entries = entriesFor(key);
      // Real sorted sets hold unique members; a duplicate updates the score.
      const existing = entries.findIndex((e) => e.member === member);
      if (existing >= 0) entries[existing].score = score;
      else entries.push({ score, member });
      return 1;
    },
    async zrangebyscore(key, min, max) {
      calls.push("zrangebyscore");
      const lo = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
      const hi = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
      return entriesFor(key)
        .filter((e) => e.score >= lo && e.score <= hi)
        .sort((a, b) => a.score - b.score)
        .map((e) => e.member);
    },
    async zremrangebyscore(key, min, max) {
      calls.push("zremrangebyscore");
      const entries = entriesFor(key);
      const lo = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
      const hi = typeof max === "number" ? max : Number(max);
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].score >= lo && entries[i].score <= hi) entries.splice(i, 1);
      }
      return 1;
    },
    async pexpire() {
      calls.push("pexpire");
      return 1;
    },
  };

  return { redis, sets, calls };
}

const NOW = 1_800_000_000_000;

/** Convenience: this asset's total in the window, 0 when absent. */
function totalFor(w: { valueByAsset: Map<string, bigint> }, asset: string): bigint {
  return w.valueByAsset.get(asset) ?? 0n;
}

// ─── Per-team separation: the property this refactor exists for ───

test("one team's spend does NOT consume another team's budget", async () => {
  // The bug this fixes. With a single global window, team A exhausting the count
  // cap halted broadcasts for every other tenant — an availability failure with
  // the same tenant-isolation shape as a cross-tenant data leak.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  // Team A spends its entire per-team USDC allowance.
  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_A, NOW);

  // Team B must be completely unaffected.
  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_B, NOW + 1);

  const wA = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  const wB = await store.teamWindow(TEAM_B, NOW + 2, VELOCITY.windowMs);
  assert.equal(totalFor(wA, USDC), 1_000n);
  assert.equal(totalFor(wB, USDC), 1_000n);
});

test("one team exhausting its count cap does NOT halt another team", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  // Team A reaches its per-team count cap of 5.
  for (let i = 0; i < 5; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + i);
  }

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 10),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "TEAM_COUNT_LIMIT");
      return true;
    },
  );

  // Team B still broadcasts normally — the whole point.
  await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_B, NOW + 11);
});

test("a team breach names the team, so an operator knows who to look at", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_A, NOW);

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 1),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "TEAM_VALUE_LIMIT");
      assert.match(err.message, new RegExp(TEAM_A), "the message must name the team");
      return true;
    },
  );
});

test("the global window still aggregates across every team", async () => {
  // Per-team scoping must not blind the platform-wide view: a compromised fee
  // payer shows up as many teams spending at once, which only the global window
  // can see.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 900n, USDC, VELOCITY, TEAM_A, NOW);
  await checkFeePayerVelocity(store, 900n, USDC, VELOCITY, TEAM_B, NOW + 1);

  const g = await store.globalWindow(NOW + 2, VELOCITY.windowMs);
  assert.equal(totalFor(g, USDC), 1_800n, "both teams count toward the global total");
  assert.equal(g.count, 2);
});

test("the GLOBAL cap still binds when many teams each stay inside their own", async () => {
  // Neither cap subsumes the other. Ten teams each well inside their per-team
  // allowance can still collectively drain the shared fee payer.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  // 20 broadcasts across 10 teams — 2 each, far under the per-team count cap of
  // 5, but exactly the global count cap of 20.
  for (let i = 0; i < 20; i++) {
    await checkFeePayerVelocity(store, 1n, USDC, VELOCITY, `team-${i % 10}`, NOW + i);
  }

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, "team-fresh", NOW + 30),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "FEE_PAYER_COUNT_LIMIT");
      return true;
    },
  );
});

test("global is reported first when both scopes are breached", async () => {
  // A platform-wide condition must not be misattributed to whichever tenant
  // happened to arrive at the wrong moment — the same ordering rule as the SOL
  // budget.
  const tight: VelocityConfig = {
    global: { maxValuePerAsset: new Map([[USDC, 100n]]), maxCountPerWindow: 1 },
    perTeam: { maxValuePerAsset: new Map([[USDC, 100n]]), maxCountPerWindow: 1 },
    windowMs: 60_000,
  };

  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 100n, USDC, tight, TEAM_A, NOW);

  await assert.rejects(
    () => checkFeePayerVelocity(store, 100n, USDC, tight, TEAM_A, NOW + 1),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "FEE_PAYER_VALUE_LIMIT", "global, not team");
      return true;
    },
  );
});

test("a refused broadcast is recorded in NEITHER window", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_A, NOW);
  await assert.rejects(() => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 1));

  const t = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  const g = await store.globalWindow(NOW + 2, VELOCITY.windowMs);
  assert.equal(t.count, 1, "the refused attempt must not be in the team window");
  assert.equal(g.count, 1, "nor in the global window");
});

// ─── Per-asset separation ───

test("tracks each asset's spend against its OWN total", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await store.record({ value: 600n, asset: USDC, at: NOW }, TEAM_A);
  await store.record({ value: 4_000n, asset: WSOL, at: NOW + 1 }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  assert.equal(totalFor(w, USDC), 600n);
  assert.equal(totalFor(w, WSOL), 4_000n);
  assert.equal(w.count, 2, "the count cap spans every asset");
});

test("spending in one asset does NOT consume another asset's budget", async () => {
  // With a single shared figure, 4,000 lamports of SOL would have eaten most of
  // a 1,000-base-unit USDC cap — a number denominated in nothing, wrong by the
  // price ratio for at least one asset.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 4_900n, WSOL, VELOCITY, TEAM_A, NOW);
  await checkFeePayerVelocity(store, 900n, USDC, VELOCITY, TEAM_A, NOW + 1);

  const w = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  assert.equal(totalFor(w, USDC), 900n);
  assert.equal(totalFor(w, WSOL), 4_900n);
});

test("each asset's cap is enforced independently", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  // USDC to its 1,000 per-team cap exactly — allowed.
  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_A, NOW);

  // One more USDC base unit crosses it.
  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 1),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "TEAM_VALUE_LIMIT");
      assert.match(err.message, new RegExp(USDC), "the message must name the asset");
      return true;
    },
  );

  // SOL still has its full budget despite USDC being exhausted.
  await checkFeePayerVelocity(store, 5_000n, WSOL, VELOCITY, TEAM_A, NOW + 2);
});

test("the count cap is shared across assets, so splitting does not evade it", async () => {
  // A per-asset count would hand an attacker a fresh budget per mint.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  for (let i = 0; i < 5; i++) {
    await checkFeePayerVelocity(store, 1n, i % 2 === 0 ? USDC : WSOL, VELOCITY, TEAM_A, NOW + i);
  }

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, WSOL, VELOCITY, TEAM_A, NOW + 10),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "TEAM_COUNT_LIMIT");
      return true;
    },
  );
});

// ─── Fail-closed on an unknown or unconfigured asset ───

test("REFUSES an asset with no configured velocity cap", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await assert.rejects(
    () =>
      checkFeePayerVelocity(
        store,
        1n,
        "SomeUnlistedMint1111111111111111111111111111",
        VELOCITY,
        TEAM_A,
        NOW,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "NO_VELOCITY_CAP_CONFIGURED");
      return true;
    },
  );
});

test("REFUSES when the asset cannot be determined", async () => {
  // A bare SPL Transfer carries no mint, so the asset is unknown. Unknown means
  // uncappable, and uncappable means refused.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, null, VELOCITY, TEAM_A, NOW),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "NO_VELOCITY_CAP_CONFIGURED");
      return true;
    },
  );
});

test("an unconfigured asset is refused BEFORE the store is touched", async () => {
  // Ordering matters: a refusal that reads the store first would report a store
  // error when the real problem is configuration.
  const { redis, calls } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await assert.rejects(() => checkFeePayerVelocity(store, 1n, null, VELOCITY, TEAM_A, NOW));
  assert.deepEqual(calls, [], "no Redis call should have been made");
});

// ─── Window arithmetic ───

test("records and reads back a single broadcast", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 250n, asset: USDC, at: NOW }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW, VELOCITY.windowMs);
  assert.equal(w.count, 1);
  assert.equal(totalFor(w, USDC), 250n);
});

test("sums value across several broadcasts of the same asset", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 100n, asset: USDC, at: NOW }, TEAM_A);
  await store.record({ value: 200n, asset: USDC, at: NOW + 1 }, TEAM_A);
  await store.record({ value: 300n, asset: USDC, at: NOW + 2 }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW + 3, VELOCITY.windowMs);
  assert.equal(w.count, 3);
  assert.equal(totalFor(w, USDC), 600n);
});

test("COUNTS two identical broadcasts at the same instant separately", async () => {
  // The bug the uuid suffix exists to prevent: sorted-set members are unique,
  // so `asset|value` alone would collapse these into one entry and undercount
  // the spend by half.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 500n, asset: USDC, at: NOW }, TEAM_A);
  await store.record({ value: 500n, asset: USDC, at: NOW }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW, VELOCITY.windowMs);
  assert.equal(w.count, 2, "both broadcasts must be counted");
  assert.equal(totalFor(w, USDC), 1000n, "both values must be summed");
});

test("excludes broadcasts older than the window", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 900n, asset: USDC, at: NOW }, TEAM_A);

  const later = NOW + VELOCITY.windowMs + 1;
  const w = await store.teamWindow(TEAM_A, later, VELOCITY.windowMs);
  assert.equal(w.count, 0);
  assert.equal(totalFor(w, USDC), 0n);
});

test("includes a broadcast exactly at the window edge", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 900n, asset: USDC, at: NOW }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW + VELOCITY.windowMs, VELOCITY.windowMs);
  assert.equal(w.count, 1, "the boundary is inclusive");
});

test("an empty window reports zero rather than throwing", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  const w = await store.teamWindow(TEAM_A, NOW, VELOCITY.windowMs);
  assert.equal(w.count, 0);
  assert.equal(w.valueByAsset.size, 0);
});

test("an unseen team reads as empty, not as the global total", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await checkFeePayerVelocity(store, 900n, USDC, VELOCITY, TEAM_A, NOW);

  const w = await store.teamWindow("team-never-seen", NOW + 1, VELOCITY.windowMs);
  assert.equal(w.count, 0, "a new team starts with a full allowance");
});

test("handles values beyond Number.MAX_SAFE_INTEGER", async () => {
  // Why the sum is bigint in Node rather than Lua: an 18-decimal token
  // overflows a double at ~9 whole units.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  const huge = 9_007_199_254_740_993n; // 2^53 + 1
  await store.record({ value: huge, asset: USDC, at: NOW }, TEAM_A);
  await store.record({ value: huge, asset: USDC, at: NOW + 1 }, TEAM_A);

  const w = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  assert.equal(totalFor(w, USDC), huge * 2n, "no precision loss");
});

// ─── Pruning and TTL ───

test("prunes entries beyond the retention horizon on write", async () => {
  const { redis, sets } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await store.record({ value: 1n, asset: USDC, at: NOW }, TEAM_A);
  // A write 25h later must drop the first entry (24h retention).
  await store.record({ value: 1n, asset: USDC, at: NOW + 25 * 60 * 60 * 1000 }, TEAM_A);

  for (const [key, entries] of sets) {
    assert.equal(entries.length, 1, `the stale entry should have been pruned from ${key}`);
  }
});

test("refreshes the key TTL on every write", async () => {
  const { redis, calls } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 1n, asset: USDC, at: NOW }, TEAM_A);
  assert.ok(calls.includes("pexpire"), "a TTL must be set so an abandoned key expires");
});

test("each read path is a single range scan", async () => {
  // Reads are on the broadcast hot path; pruning belongs on the write side.
  const { redis, calls } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 1n, asset: USDC, at: NOW }, TEAM_A);
  calls.length = 0;

  await store.teamWindow(TEAM_A, NOW, VELOCITY.windowMs);
  assert.deepEqual(calls, ["zrangebyscore"]);

  calls.length = 0;
  await store.globalWindow(NOW, VELOCITY.windowMs);
  assert.deepEqual(calls, ["zrangebyscore"]);
});

test("a team's spend lands in both its own key and the global one", async () => {
  const { redis, sets } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);
  await store.record({ value: 1n, asset: USDC, at: NOW }, TEAM_A);

  const keys = [...sets.keys()];
  assert.ok(
    keys.some((k) => k.includes(TEAM_A)),
    "a per-team key must exist",
  );
  assert.ok(
    keys.some((k) => k.endsWith(":global")),
    "the global aggregate must exist",
  );
});

// ─── Corrupt data must not halt broadcasting ───

test("attributes value to the right asset when parsing members", () => {
  const totals = sumVelocityMembers([`${USDC}|100|a`, `${WSOL}|50|b`, `${USDC}|200|c`]);
  assert.equal(totals.get(USDC), 300n);
  assert.equal(totals.get(WSOL), 50n);
});

test("skips a malformed member rather than throwing", () => {
  // Throwing here would trip checkFeePayerVelocity's fail-closed path and stop
  // every broadcast. Undercounting by one entry is the lesser harm.
  const totals = sumVelocityMembers([`${USDC}|100|a`, "garbage", `${USDC}|200|b`]);
  assert.equal(totals.get(USDC), 300n);
});

test("skips a member with no separator", () => {
  // The format is `asset|value|uuid`; a bare token carries no asset, so it
  // cannot be attributed and is dropped.
  assert.equal(sumVelocityMembers(["500"]).size, 0);
});

test("skips a member whose value is not a number", () => {
  assert.equal(sumVelocityMembers([`${USDC}|notanumber|a`]).size, 0);
});

test("an entirely corrupt window reads as empty, not an error", () => {
  assert.equal(sumVelocityMembers(["x", "y", "z"]).size, 0);
});

// ─── Integration with the breaker ───

test("the breaker halts using the durable window", async () => {
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  // Five USDC broadcasts at 200 = 1,000, exactly the per-team USDC value cap and
  // the per-team count cap.
  for (let i = 0; i < 5; i++) {
    await checkFeePayerVelocity(store, 200n, USDC, VELOCITY, TEAM_A, NOW + i);
  }

  await assert.rejects(
    () => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 10),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      // Value cap is checked before count, so it reports first.
      assert.equal(err.failure.code, "TEAM_VALUE_LIMIT");
      return true;
    },
  );
});

test("does not record a broadcast that was refused", async () => {
  // A blocked attempt must not consume window budget, or repeated blocked
  // attempts would compound into a longer outage than the breach warrants.
  const { redis } = fakeRedis();
  const store = new RedisVelocityStore(redis, PREFIX);

  await checkFeePayerVelocity(store, 1_000n, USDC, VELOCITY, TEAM_A, NOW);
  await assert.rejects(() => checkFeePayerVelocity(store, 1n, USDC, VELOCITY, TEAM_A, NOW + 1));

  const w = await store.teamWindow(TEAM_A, NOW + 2, VELOCITY.windowMs);
  assert.equal(w.count, 1, "the refused attempt must not have been recorded");
  assert.equal(totalFor(w, USDC), 1_000n);
});

test("the window SURVIVES a simulated process restart", async () => {
  // The whole point. A new store over the same Redis sees prior spend, where a
  // new in-memory store would have started from zero.
  const { redis } = fakeRedis();

  const beforeRestart = new RedisVelocityStore(redis, PREFIX);
  await checkFeePayerVelocity(beforeRestart, 1_000n, USDC, VELOCITY, TEAM_A, NOW);

  const afterRestart = new RedisVelocityStore(redis, PREFIX);
  await assert.rejects(
    () => checkFeePayerVelocity(afterRestart, 1n, USDC, VELOCITY, TEAM_A, NOW + 1),
    SpendPolicyError,
    "a restart must not reset the breaker",
  );
});

test("BLOCKS when Redis reads fail — fail closed", async () => {
  const broken: RedisLike = {
    async zadd() {
      return 1;
    },
    async zrangebyscore() {
      throw new Error("READONLY You can't write against a read only replica");
    },
    async zremrangebyscore() {
      return 1;
    },
    async pexpire() {
      return 1;
    },
  };

  await assert.rejects(
    () =>
      checkFeePayerVelocity(
        new RedisVelocityStore(broken, PREFIX),
        1n,
        USDC,
        VELOCITY,
        TEAM_A,
        NOW,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "VELOCITY_STORE_UNAVAILABLE");
      return true;
    },
  );
});

test("BLOCKS when Redis writes fail — fail closed", async () => {
  const broken: RedisLike = {
    async zadd() {
      throw new Error("OOM command not allowed when used memory > maxmemory");
    },
    async zrangebyscore() {
      return [];
    },
    async zremrangebyscore() {
      return 1;
    },
    async pexpire() {
      return 1;
    },
  };

  await assert.rejects(
    () =>
      checkFeePayerVelocity(
        new RedisVelocityStore(broken, PREFIX),
        1n,
        USDC,
        VELOCITY,
        TEAM_A,
        NOW,
      ),
    (err: unknown) => {
      assert.ok(err instanceof SpendPolicyError);
      assert.equal(err.failure.code, "VELOCITY_STORE_WRITE_FAILED");
      return true;
    },
  );
});
