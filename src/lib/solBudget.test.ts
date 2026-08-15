import test from "node:test";
import assert from "node:assert/strict";
import {
  reserveSolSpend,
  reconcileSolSpend,
  releaseSolReservation,
  checkSolBudgetAvailable,
  worstCaseCostLamports,
  retryAfterSeconds,
  isSolBudgetDeferral,
  retryAfterSecondsFrom,
  SolBudgetExceededError,
  SolBudgetUnavailableError,
  ATA_RENT_LAMPORTS,
  LAMPORTS_PER_SIGNATURE,
  SOL_BUDGET_STORE_RETRY_SECONDS,
  DEFAULT_SOL_BUDGET_CONFIG,
  type SolBudgetConfig,
  type SolBudgetStore,
} from "./solBudget.js";
import { InMemorySolBudgetStore } from "./solBudgetStore.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * Rolling SOL budget — the guard that makes open token support defensible.
 *
 * An unlisted mint has no meaningful value cap without a price oracle, so this
 * caps what the relayer *spends* instead: lamports on fees and ATA rent. The
 * tests that matter most are the dual-cap interaction (neither ceiling subsumes
 * the other) and the reservation lifecycle (a refused attempt must not consume
 * budget, and over-reservation must be given back).
 */

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

/** Global 1 SOL, per-team 0.02 SOL — the shape after velocity became per-team. */
const CONFIG: SolBudgetConfig = {
  globalMaxLamports: 1_000_000_000n,
  perTeamMaxLamports: 20_000_000n,
  windowMs: HOUR,
};

let counter = 0;
const nextId = () => `res-${++counter}`;

async function expectBreach(
  fn: () => Promise<unknown>,
  breach: "global" | "team",
  code: string,
) {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof SolBudgetExceededError, `expected budget error, got ${err}`);
    assert.equal(err.breach, breach);
    assert.equal(err.failure.code, code);
    assert.equal(err.failure.stage, RelayerFailureStage.PolicyCheck);
    return true;
  });
}

// ─── Worst-case costing ───

test("worst case assumes two signatures and ATA creation", () => {
  // Both are the expensive branch on purpose: under-reserving lets concurrent
  // workers collectively breach the cap.
  const cost = worstCaseCostLamports({});
  assert.equal(cost, LAMPORTS_PER_SIGNATURE * 2n + ATA_RENT_LAMPORTS);
});

test("a known-existing ATA costs no rent", () => {
  const cost = worstCaseCostLamports({ ataCreations: 0 });
  assert.equal(cost, LAMPORTS_PER_SIGNATURE * 2n);
});

test("rent scales with the number of ATAs created", () => {
  // A payment with fees creates one account per destination, and rent is
  // charged per account. This was a boolean, so every multi-party payment
  // reserved the rent of a single one and under-reserved the rest.
  assert.equal(
    worstCaseCostLamports({ ataCreations: 3 }),
    LAMPORTS_PER_SIGNATURE * 2n + ATA_RENT_LAMPORTS * 3n,
  );
});

test("omitting the ATA count still reserves for one", () => {
  // The default has to stay the expensive branch: a caller that has not yet
  // built the transaction cannot know the count, and guessing zero would admit
  // work the worker then refuses.
  assert.equal(worstCaseCostLamports({}), worstCaseCostLamports({ ataCreations: 1 }));
});

test("priority fees are included", () => {
  const cost = worstCaseCostLamports({ priorityFeeLamports: 50_000n });
  assert.equal(cost, LAMPORTS_PER_SIGNATURE * 2n + ATA_RENT_LAMPORTS + 50_000n);
});

test("ATA rent dominates the cost of a dust transfer", () => {
  // Why this guard exists at all: the fee is trivial, the rent is 200x it. An
  // attacker minting a worthless token and spraying fresh recipients costs the
  // relayer rent every time, and no token-denominated cap would notice.
  const cost = worstCaseCostLamports({});
  assert.ok(ATA_RENT_LAMPORTS > LAMPORTS_PER_SIGNATURE * 100n);
  assert.ok(cost > 2_000_000n);
});

// ─── Dual caps: neither subsumes the other ───

test("a spend inside both ceilings is reserved", async () => {
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 10_000_000n, reservationId: nextId() }, CONFIG, NOW);

  const w = await store.window(TEAM_A, NOW, HOUR);
  assert.equal(w.globalLamports, 10_000_000n);
  assert.equal(w.teamLamports, 10_000_000n);
});

test("the per-team ceiling stops one team well short of the global pool", async () => {
  // Without a per-team cap, one compromised key would consume the entire global
  // budget and starve every honest team.
  const store = new InMemorySolBudgetStore();

  // 0.02 SOL exactly — at the per-team cap, still allowed.
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  // One more lamport for the same team is refused, despite 0.98 SOL of global
  // headroom remaining.
  await expectBreach(
    () => reserveSolSpend(store, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW + 1),
    "team",
    "SOL_BUDGET_TEAM_EXCEEDED",
  );

  // And a different team is unaffected.
  await reserveSolSpend(store, { teamId: TEAM_B, lamports: 10_000_000n, reservationId: nextId() }, CONFIG, NOW + 2);
});

test("the global ceiling stops many teams from collectively draining the pool", async () => {
  // Without a global cap, N teams each spending their full per-team allowance
  // drains N x the intended maximum from one shared fee payer.
  //
  // With per-team at 0.02 SOL, it takes 50 teams to exhaust the 1 SOL pool —
  // which is the point: the global cap has to hold when no individual team is
  // misbehaving.
  const store = new InMemorySolBudgetStore();

  for (let i = 0; i < 50; i++) {
    await reserveSolSpend(
      store,
      { teamId: `team-${i}`, lamports: 20_000_000n, reservationId: nextId() },
      CONFIG,
      NOW + i,
    );
  }

  // A fifty-first team is refused on the global ceiling even though it has spent
  // nothing itself.
  await expectBreach(
    () => reserveSolSpend(store, { teamId: "team-51", lamports: 1n, reservationId: nextId() }, CONFIG, NOW + 60),
    "global",
    "SOL_BUDGET_GLOBAL_EXCEEDED",
  );
});

test("global is checked before per-team, so a platform breach is not blamed on a tenant", async () => {
  // A team arriving when the pool is dry should learn the platform is at
  // capacity, not that it personally overspent.
  const store = new InMemorySolBudgetStore();
  for (let i = 0; i < 50; i++) {
    await reserveSolSpend(
      store,
      { teamId: `team-${i}`, lamports: 20_000_000n, reservationId: nextId() },
      CONFIG,
      NOW + i,
    );
  }

  // A fresh team requesting more than its own per-team cap would breach both.
  // The reported breach must be global.
  await expectBreach(
    () => reserveSolSpend(store, { teamId: "fresh", lamports: 40_000_000n, reservationId: nextId() }, CONFIG, NOW + 60),
    "global",
    "SOL_BUDGET_GLOBAL_EXCEEDED",
  );
});

// ─── Refused attempts consume nothing ───

test("a refused reservation does NOT consume budget", async () => {
  // Otherwise repeated refusals compound into an outage far longer than the
  // breach warrants.
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  for (let i = 0; i < 5; i++) {
    await expectBreach(
      () => reserveSolSpend(store, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW + i),
      "team",
      "SOL_BUDGET_TEAM_EXCEEDED",
    );
  }

  const w = await store.window(TEAM_A, NOW + 10, HOUR);
  assert.equal(w.teamLamports, 20_000_000n, "only the one successful reservation should count");
});

// ─── Reservation lifecycle ───

test("reconciling down returns the over-reserved difference", async () => {
  // Worst case assumes ATA creation. When the ATA already existed, the rent was
  // never spent and must be given back or the budget stays needlessly tight.
  const store = new InMemorySolBudgetStore();
  const id = nextId();
  const reserved = worstCaseCostLamports({});
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: reserved, reservationId: id }, CONFIG, NOW);

  const actual = LAMPORTS_PER_SIGNATURE * 2n; // no ATA was created
  await reconcileSolSpend(store, id, actual);

  const w = await store.window(TEAM_A, NOW, HOUR);
  assert.equal(w.teamLamports, actual, "the reservation should now hold only the real cost");
  assert.ok(w.teamLamports < reserved);
});

test("releasing frees the whole reservation", async () => {
  const store = new InMemorySolBudgetStore();
  const id = nextId();
  // Derived from the cap rather than a literal: this test is about release, not
  // about any particular magnitude, and a hardcoded figure silently becomes
  // unreservable the next time the ceiling is recalibrated. Filling it exactly
  // also makes the assertion stronger — the entire allowance comes back.
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: CONFIG.perTeamMaxLamports, reservationId: id },
    CONFIG,
    NOW,
  );
  await releaseSolReservation(store, id);

  const w = await store.window(TEAM_A, NOW, HOUR);
  assert.equal(w.teamLamports, 0n);
});

test("reconciliation failure does NOT throw", async () => {
  // A transaction that already landed must not be reported as failed because a
  // bookkeeping write did not stick. Leaving the worst-case figure in place
  // over-counts spend, which is the safe direction.
  const broken: SolBudgetStore = {
    async reserve() {},
    async reconcile() {
      throw new Error("redis write timeout");
    },
    async release() {},
    async window() {
      return { globalLamports: 0n, teamLamports: 0n, oldestAt: null };
    },
  };

  let reported: string | null = null;
  await reconcileSolSpend(broken, "res-x", 1n, (r) => {
    reported = r;
  });
  assert.match(String(reported), /redis write timeout/, "the failure must still be surfaced");
});

test("release failure does NOT throw", async () => {
  const broken: SolBudgetStore = {
    async reserve() {},
    async reconcile() {},
    async release() {
      throw new Error("connection reset");
    },
    async window() {
      return { globalLamports: 0n, teamLamports: 0n, oldestAt: null };
    },
  };

  let reported: string | null = null;
  await releaseSolReservation(broken, "res-x", (r) => {
    reported = r;
  });
  assert.match(String(reported), /connection reset/);
});

test("reconciling an aged-out reservation is a no-op, not an error", async () => {
  // A slow confirmation can outlive the window. That is normal.
  const store = new InMemorySolBudgetStore();
  await reconcileSolSpend(store, "never-existed", 1n);
});

// ─── Window rolling ───

test("spend leaves the window once it ages out", async () => {
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  // At the cap, so refused now.
  await expectBreach(
    () => reserveSolSpend(store, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW + 1),
    "team",
    "SOL_BUDGET_TEAM_EXCEEDED",
  );

  // An hour and a millisecond later, the earlier spend no longer counts.
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() },
    CONFIG,
    NOW + HOUR + 1,
  );
});

// ─── Retry-After ───

test("Retry-After counts from when the oldest entry expires", async () => {
  // Budget frees when the oldest reservation leaves the window, so that is the
  // soonest a retry could succeed.
  const oldestAt = NOW;
  const now = NOW + 10 * 60 * 1000; // 10 minutes later
  const seconds = retryAfterSeconds(oldestAt, now, HOUR);
  assert.equal(seconds, 50 * 60, "50 minutes remain on the oldest entry");
});

test("Retry-After is never zero", async () => {
  // A client receiving 0 would hot-loop.
  const seconds = retryAfterSeconds(NOW, NOW + HOUR, HOUR);
  assert.ok(seconds >= 1);
});

test("an empty window reports the full window, not an immediate retry", () => {
  // Nothing is held yet the cap was hit, so the request alone exceeds the
  // ceiling. No amount of waiting helps, and claiming otherwise invites a
  // pointless immediate retry.
  assert.equal(retryAfterSeconds(null, NOW, HOUR), 3600);
});

test("the breach error carries a usable Retry-After", async () => {
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  await assert.rejects(
    () => reserveSolSpend(store, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW + 60_000),
    (err: unknown) => {
      assert.ok(err instanceof SolBudgetExceededError);
      // One minute has elapsed of the hour, so ~59 remain.
      assert.ok(err.retryAfterSeconds > 3500 && err.retryAfterSeconds <= 3600);
      return true;
    },
  );
});

// ─── Retriability: unlike other policy refusals, these are temporary ───

test("a budget breach is RETRIABLE, unlike a ceiling breach", async () => {
  // Every other policy refusal is permanent because the transaction is
  // defective. Here the transaction is fine and the relayer is merely out of
  // budget — marking it permanent would discard legitimate work.
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  await assert.rejects(
    () => reserveSolSpend(store, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW + 1),
    (err: unknown) => {
      assert.ok(err instanceof SolBudgetExceededError);
      assert.equal(err.failure.retriable, true, "the queue should retry once budget frees");
      return true;
    },
  );
});

// ─── Fail-closed on store failure ───

test("BLOCKS when the budget store cannot be read — fail closed", async () => {
  const broken: SolBudgetStore = {
    async reserve() {},
    async reconcile() {},
    async release() {},
    async window() {
      throw new Error("redis connection refused");
    },
  };

  await assert.rejects(
    () => reserveSolSpend(broken, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW),
    (err: unknown) => {
      assert.ok(err instanceof SolBudgetUnavailableError);
      assert.equal(err.failure.code, "SOL_BUDGET_STORE_UNAVAILABLE");
      assert.equal(err.failure.retriable, true, "a store outage is transient");
      assert.match(err.message, /redis connection refused/);
      return true;
    },
  );
});

test("BLOCKS when the reservation cannot be written — fail closed", async () => {
  // An unrecorded reservation is invisible to every later check, so the cap
  // would silently stop binding.
  const broken: SolBudgetStore = {
    async reserve() {
      throw new Error("OOM command not allowed");
    },
    async reconcile() {},
    async release() {},
    async window() {
      return { globalLamports: 0n, teamLamports: 0n, oldestAt: null };
    },
  };

  await assert.rejects(
    () => reserveSolSpend(broken, { teamId: TEAM_A, lamports: 1n, reservationId: nextId() }, CONFIG, NOW),
    SolBudgetUnavailableError,
  );
});

// ─── Team isolation within the budget ───

test("one team's spend does not count against another's allowance", async () => {
  const store = new InMemorySolBudgetStore();
  // Team A at its full allowance — the strongest version of this test, since a
  // leak into team B's window would be maximally visible.
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: CONFIG.perTeamMaxLamports, reservationId: nextId() },
    CONFIG,
    NOW,
  );

  const wB = await store.window(TEAM_B, NOW, HOUR);
  assert.equal(wB.teamLamports, 0n, "team B has spent nothing");
  assert.equal(wB.globalLamports, CONFIG.perTeamMaxLamports, "but sees the global total");
});

// ─── Ingress admission check ───
//
// A read-only mirror of the worker's gate, so a client learns synchronously
// rather than polling a job that cannot progress. Two properties carry the
// weight: it must NOT reserve (the worker reserves, and double-counting would
// halve the effective cap), and it must agree with the worker about the caps.

test("admission passes when there is room, and takes no reservation", async () => {
  const store = new InMemorySolBudgetStore();

  const refusal = await checkSolBudgetAvailable(
    store,
    { teamId: TEAM_A, lamports: 10_000_000n },
    CONFIG,
    NOW,
  );
  assert.equal(refusal, null, "there is room");

  // The critical property. If this check reserved, the worker's own reservation
  // would double-count the same transaction: the window would fill at twice the
  // real rate and the effective cap would be half what is configured.
  const w = await store.window(TEAM_A, NOW, HOUR);
  assert.equal(w.globalLamports, 0n, "checking must not consume budget");
  assert.equal(w.teamLamports, 0n, "checking must not consume budget");
});

test("admission refuses on the per-team ceiling", async () => {
  const store = new InMemorySolBudgetStore();
  // Exactly at the ceiling, which the reservation admits (the check is `>`, not
  // `>=`). Any further spend must then be refused — which is the property here.
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: CONFIG.perTeamMaxLamports, reservationId: nextId() },
    CONFIG,
    NOW,
  );

  const refusal = await checkSolBudgetAvailable(
    store,
    { teamId: TEAM_A, lamports: 5_000_000n },
    CONFIG,
    NOW,
  );
  assert.ok(refusal instanceof SolBudgetExceededError);
  // Team, not global: one team at its own ceiling has barely touched the pool.
  assert.equal(refusal.breach, "team");
});

test("admission refuses on the global ceiling, reported as global", async () => {
  const store = new InMemorySolBudgetStore();
  // Fifty teams each at their full per-team allowance exhausts the global pool.
  for (let i = 0; i < 50; i++) {
    await reserveSolSpend(
      store,
      { teamId: `team-${i}`, lamports: 20_000_000n, reservationId: nextId() },
      CONFIG,
      NOW,
    );
  }

  const refusal = await checkSolBudgetAvailable(
    store,
    { teamId: TEAM_B, lamports: 1_000_000n },
    CONFIG,
    NOW,
  );
  assert.ok(refusal instanceof SolBudgetExceededError);
  // TEAM_B has spent nothing — blaming it for a platform-wide condition would
  // send an operator looking at the wrong tenant.
  assert.equal(refusal.breach, "global");
});

test("admission carries a usable Retry-After", async () => {
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(store, { teamId: TEAM_A, lamports: 20_000_000n, reservationId: nextId() }, CONFIG, NOW);

  const refusal = await checkSolBudgetAvailable(
    store,
    { teamId: TEAM_A, lamports: 1_000_000n },
    CONFIG,
    NOW,
  );
  assert.ok(refusal instanceof SolBudgetExceededError);
  assert.ok(refusal.retryAfterSeconds >= 1, "never zero — a client would hot-loop");
  assert.ok(refusal.retryAfterSeconds <= 3600, "never beyond the window");
});

test("admission REFUSES when the store cannot be read — fail closed", async () => {
  const broken: SolBudgetStore = {
    reserve: async () => undefined,
    reconcile: async () => undefined,
    release: async () => undefined,
    window: async () => {
      throw new Error("redis down");
    },
  };

  const refusal = await checkSolBudgetAvailable(
    broken,
    { teamId: TEAM_A, lamports: 1n },
    CONFIG,
    NOW,
  );
  // A budget that cannot be read is not evidence of headroom.
  assert.ok(refusal instanceof SolBudgetUnavailableError);
});

test("admission returns rather than throws — at ingress this is a response", async () => {
  const store = new InMemorySolBudgetStore();
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: CONFIG.perTeamMaxLamports, reservationId: nextId() },
    CONFIG,
    NOW,
  );

  // reserveSolSpend throws; this returns. The difference is deliberate: ingress
  // serializes the refusal into a 429 body, and a throw there would become a 500.
  const refusal = await checkSolBudgetAvailable(store, { teamId: TEAM_A, lamports: 1_000_000n }, CONFIG, NOW);
  assert.ok(refusal instanceof Error, "the error is returned, not raised");
});

test("admission agrees with the worker: what one refuses, the other refuses", async () => {
  const store = new InMemorySolBudgetStore();
  const cost = worstCaseCostLamports({ signatures: 2, ataCreations: 1 });

  // Fill the team's allowance to just under the ceiling.
  await reserveSolSpend(
    store,
    { teamId: TEAM_A, lamports: CONFIG.perTeamMaxLamports - cost + 1n, reservationId: nextId() },
    CONFIG,
    NOW,
  );

  const refusal = await checkSolBudgetAvailable(store, { teamId: TEAM_A, lamports: cost }, CONFIG, NOW);
  assert.ok(refusal instanceof SolBudgetExceededError, "ingress refuses");

  await assert.rejects(
    () => reserveSolSpend(store, { teamId: TEAM_A, lamports: cost, reservationId: nextId() }, CONFIG, NOW),
    SolBudgetExceededError,
    "and the worker would too — the two gates must not disagree",
  );
});

// ─── Shared config ───

test("ingress and worker read the same caps from one definition", () => {
  // Two copies of these numbers would drift silently: the API would accept work
  // the worker then refuses, leaving jobs deferred with nothing explaining why.
  assert.equal(DEFAULT_SOL_BUDGET_CONFIG.globalMaxLamports, 1_000_000_000n, "1 SOL/hour global");
  assert.equal(DEFAULT_SOL_BUDGET_CONFIG.perTeamMaxLamports, 20_000_000n, "0.02 SOL/hour per team");
  assert.equal(DEFAULT_SOL_BUDGET_CONFIG.windowMs, 60 * 60 * 1000);
});

test("the per-team cap is below the global one, or it would be inert", () => {
  assert.ok(
    DEFAULT_SOL_BUDGET_CONFIG.perTeamMaxLamports < DEFAULT_SOL_BUDGET_CONFIG.globalMaxLamports,
    "a per-team cap at or above the global cap could never bind",
  );
});

test("SOL budget and velocity caps are calibrated to bind at similar traffic volumes", () => {
  // The per-team velocity cap is 10 tx/hour (from broadcast.ts VELOCITY_CONFIG.perTeam.maxCount).
  // The per-team SOL budget cap is 0.02 SOL = 20M lamports.
  // At worst-case tx cost (~2.05M lamports for ATA creation), 10 tx burns ~20.5M lamports.
  //
  // So a team hitting its velocity ceiling also approaches its SOL ceiling, making
  // the SOL cap a meaningful secondary guard rather than dead code that never binds.
  const perTeamVelocityCount = 10; // from VELOCITY_CONFIG.perTeam.maxCount
  const worstCaseTxCost = 2_049_280n; // ATA rent + 2 signatures
  const worstCaseSpendAtVelocityCap = BigInt(perTeamVelocityCount) * worstCaseTxCost;

  // At worst-case cost, hitting velocity uses ~20.5M of the 20M SOL budget.
  assert.ok(
    worstCaseSpendAtVelocityCap >= DEFAULT_SOL_BUDGET_CONFIG.perTeamMaxLamports,
    "velocity and SOL budget caps should bind at similar traffic levels — if velocity allows " +
      "far more spend than SOL budget, one guard is unreachable; if far less, the other never binds",
  );

  // And it's within the same order of magnitude, not 10x off.
  const ratio = Number(worstCaseSpendAtVelocityCap) / Number(DEFAULT_SOL_BUDGET_CONFIG.perTeamMaxLamports);
  assert.ok(
    ratio >= 0.5 && ratio <= 2.0,
    `caps should be within 2x of each other; actual ratio: ${ratio.toFixed(2)}`,
  );
});

// ─── Worker deferral helpers ───

test("budget codes are deferrals, ordinary failures are not", () => {
  assert.equal(
    isSolBudgetDeferral({ success: false, failure: { code: "SOL_BUDGET_GLOBAL_EXCEEDED" } }),
    true,
  );
  assert.equal(
    isSolBudgetDeferral({ success: false, failure: { code: "SOL_BUDGET_TEAM_EXCEEDED" } }),
    true,
  );
  assert.equal(
    isSolBudgetDeferral({ success: false, failure: { code: "SOL_BUDGET_STORE_UNAVAILABLE" } }),
    true,
  );
  // A ceiling breach is permanent — the transaction is defective. Deferring it
  // would retry an amount that can never be accepted.
  assert.equal(
    isSolBudgetDeferral({ success: false, failure: { code: "AMOUNT_CEILING_EXCEEDED" } }),
    false,
  );
});

test("a successful result is never a deferral", () => {
  assert.equal(isSolBudgetDeferral({ success: true }), false);
});

test("a failure with no code is not a deferral", () => {
  assert.equal(isSolBudgetDeferral({ success: false }), false);
});

test("the deferral delay falls back rather than producing NaN", () => {
  assert.equal(retryAfterSecondsFrom({ retryAfterSeconds: 42 }), 42);
  // A malformed value must not reach moveToDelayed — NaN or a negative would
  // schedule the job to an invalid timestamp.
  assert.equal(retryAfterSecondsFrom({}), SOL_BUDGET_STORE_RETRY_SECONDS);
  assert.equal(retryAfterSecondsFrom({ retryAfterSeconds: 0 }), SOL_BUDGET_STORE_RETRY_SECONDS);
  assert.equal(retryAfterSecondsFrom({ retryAfterSeconds: -5 }), SOL_BUDGET_STORE_RETRY_SECONDS);
  assert.equal(retryAfterSecondsFrom({ retryAfterSeconds: NaN }), SOL_BUDGET_STORE_RETRY_SECONDS);
});

test("a fractional delay rounds up, never down to zero", () => {
  assert.equal(retryAfterSecondsFrom({ retryAfterSeconds: 0.4 }), 1);
});
