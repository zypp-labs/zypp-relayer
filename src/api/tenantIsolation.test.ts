import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getJobByIdForTeam,
  getRecentJobsForTeam,
  getOpsMetricsForTeam,
} from "../store/jobs.js";

/**
 * B1 cross-tenant isolation.
 *
 * Two teams, two API keys, one shared relayer. Team A must not be able to read,
 * list, or aggregate team B's jobs through any endpoint — and must not learn
 * that B's jobs exist from a dedup conflict.
 *
 * These drive the store functions against a fake Supabase that records the
 * filters it was given, rather than a live database. That keeps the suite
 * hermetic while still asserting the thing that actually matters: every read
 * carries an `.eq("team_id", ...)`. A live-database version would prove the
 * same property more convincingly but could not run in CI without credentials
 * — see jobStatusEnum.test.ts for the same tradeoff.
 */

const TEAM_A = "aaaaaaaa-0000-4000-8000-000000000001";
const TEAM_B = "bbbbbbbb-0000-4000-8000-000000000002";

const JOB_OF_A = {
  id: "11111111-0000-4000-8000-00000000000a",
  team_id: TEAM_A,
  status: "confirmed",
  // fromBytea expects Postgres's \x-hex bytea encoding.
  payload: "\\x00",
  intent_sender: "SenderA",
  tx_signature: "sigA",
  intent_fee: "0.01",
  intent_total: "10.01",
  intent_currency: "USDC",
};

/** Team A also moves a second asset, so per-currency separation is testable. */
const SOL_JOB_OF_A = {
  id: "33333333-0000-4000-8000-00000000000c",
  team_id: TEAM_A,
  status: "confirmed",
  payload: "\\x00",
  intent_sender: "SenderA",
  tx_signature: "sigA2",
  intent_fee: "0.5",
  intent_total: "2.5",
  intent_currency: "SOL",
};

const JOB_OF_B = {
  id: "22222222-0000-4000-8000-00000000000b",
  team_id: TEAM_B,
  status: "confirmed",
  payload: "\\x00",
  intent_sender: "SenderB",
  tx_signature: "sigB",
  intent_fee: "0.02",
  intent_total: "20.02",
  intent_currency: "USDC",
};

const ALL_JOBS = [JOB_OF_A, SOL_JOB_OF_A, JOB_OF_B];

interface RecordedFilter {
  column: string;
  value: unknown;
}

/**
 * Minimal Supabase query-builder double.
 *
 * Applies `.eq()` filters to the seeded rows exactly as PostgREST would, so a
 * store function that forgets `team_id` returns the other tenant's row and the
 * assertion fails — which is the point.
 */
function fakeSupabase(rows: Record<string, unknown>[]) {
  const filtersSeen: RecordedFilter[] = [];

  const builder = (table: string) => {
    // Fresh copies per query. `getJobByIdForTeam` runs the row through
    // `fromBytea`, which replaces `payload` in place with a Buffer — so shared
    // fixture objects would leak a Buffer into the next test and blow up on
    // `.startsWith`. Real queries always return fresh rows; the fake must too.
    let working = rows.map((row) => ({ ...row }));
    const chain: Record<string, unknown> = {
      select() {
        return chain;
      },
      eq(column: string, value: unknown) {
        filtersSeen.push({ column, value });
        working = working.filter((r) => r[column] === value);
        return chain;
      },
      in(column: string, values: unknown[]) {
        working = working.filter((r) => values.includes(r[column]));
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      maybeSingle() {
        return Promise.resolve({ data: working[0] ?? null, error: null });
      },
      single() {
        return Promise.resolve({ data: working[0] ?? null, error: null });
      },
      then(resolve: (v: unknown) => unknown) {
        return Promise.resolve({ data: working, error: null }).then(resolve);
      },
    };
    void table;
    return chain;
  };

  return {
    client: { from: builder } as never,
    filtersSeen,
    teamFilters: () => filtersSeen.filter((f) => f.column === "team_id"),
  };
}

// ─── Reads by id ───

test("team A can read its own job", async () => {
  const { client } = fakeSupabase(ALL_JOBS);
  const job = await getJobByIdForTeam(client, JOB_OF_A.id, TEAM_A);
  assert.ok(job, "team A should see its own job");
  assert.equal(job.id, JOB_OF_A.id);
});

test("team A CANNOT read team B's job by id", async () => {
  // The core leak. Before B1, getJobById filtered on id alone, so knowing an id
  // was enough to read another tenant's sender, signature, and economics.
  const { client } = fakeSupabase(ALL_JOBS);
  const job = await getJobByIdForTeam(client, JOB_OF_B.id, TEAM_A);
  assert.equal(job, null, "team A must not receive team B's job");
});

test("a cross-tenant read is indistinguishable from a missing job", async () => {
  // Both return null, so the route's 404 cannot be used as an existence oracle
  // for another tenant's job ids.
  const { client } = fakeSupabase(ALL_JOBS);
  const foreign = await getJobByIdForTeam(client, JOB_OF_B.id, TEAM_A);
  const absent = await getJobByIdForTeam(client, "99999999-0000-4000-8000-00000000ffff", TEAM_A);
  assert.equal(foreign, absent);
});

test("the by-id read filters on team_id, not just id", async () => {
  const { client, teamFilters } = fakeSupabase(ALL_JOBS);
  await getJobByIdForTeam(client, JOB_OF_A.id, TEAM_A);
  assert.deepEqual(
    teamFilters(),
    [{ column: "team_id", value: TEAM_A }],
    "exactly one team_id filter must be applied",
  );
});

// ─── Listing ───

test("recent-jobs listing returns only the caller's rows", async () => {
  const { client } = fakeSupabase(ALL_JOBS);
  const rows = (await getRecentJobsForTeam(client, TEAM_A, 20)) as { id: string }[];
  assert.equal(rows.length, 2, "team A's two jobs, and not team B's");
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(JOB_OF_A.id));
  assert.ok(ids.includes(SOL_JOB_OF_A.id));
  assert.ok(!ids.includes(JOB_OF_B.id), "team B's job must not appear");
});

test("team B's listing is disjoint from team A's", async () => {
  const a = fakeSupabase(ALL_JOBS);
  const b = fakeSupabase(ALL_JOBS);
  const rowsA = (await getRecentJobsForTeam(a.client, TEAM_A, 20)) as { id: string }[];
  const rowsB = (await getRecentJobsForTeam(b.client, TEAM_B, 20)) as { id: string }[];
  const idsA = new Set(rowsA.map((r) => r.id));
  for (const row of rowsB) {
    assert.equal(idsA.has(row.id), false, `job ${row.id} leaked across tenants`);
  }
});

// ─── Aggregates ───

test("ops metrics count only the caller's jobs", async () => {
  // get_ops_metrics() aggregates the whole table and cannot be served to a
  // tenant. getOpsMetricsForTeam recomputes the same shape, scoped.
  const { client } = fakeSupabase(ALL_JOBS);
  const metrics = await getOpsMetricsForTeam(client, TEAM_A);
  assert.equal(metrics.counts.total, "2", "team A has two jobs");
  assert.equal(metrics.counts.confirmed, "2");
});

test("ops metrics do not leak another tenant's economics", async () => {
  // Team B's fee is 0.02 and total 20.02; neither may appear in A's figures.
  const { client } = fakeSupabase(ALL_JOBS);
  const metrics = await getOpsMetricsForTeam(client, TEAM_A);
  assert.equal(metrics.by_currency.USDC.fees_collected, "0.01");
  assert.equal(metrics.by_currency.USDC.transfer_total, "10.01");
});

test("economics are grouped per currency, never summed across them", async () => {
  // The bug this replaces: every mint's figures were added together and labelled
  // `fees_collected_usdc`. USDC at 6 decimals plus SOL at 9 is a number
  // denominated in nothing, under a label asserting it is dollars.
  const { client } = fakeSupabase(ALL_JOBS);
  const metrics = await getOpsMetricsForTeam(client, TEAM_A);

  assert.equal(metrics.by_currency.USDC.transfer_total, "10.01");
  assert.equal(metrics.by_currency.SOL.transfer_total, "2.5");
  assert.equal(metrics.by_currency.USDC.confirmed_count, "1");
  assert.equal(metrics.by_currency.SOL.confirmed_count, "1");

  // 10.01 + 2.5 = 12.51 would be the old, meaningless combined figure.
  for (const bucket of Object.values(metrics.by_currency)) {
    assert.notEqual(bucket.transfer_total, "12.51", "currencies must not be summed together");
  }
});

test("a team with no jobs sees an empty breakdown, not everyone else's totals", async () => {
  const { client } = fakeSupabase(ALL_JOBS);
  const metrics = await getOpsMetricsForTeam(client, "cccccccc-0000-4000-8000-000000000003");
  assert.equal(metrics.counts.total, "0");
  assert.deepEqual(metrics.by_currency, {}, "no currencies, rather than a zeroed USDC bucket");
});

test("rows with no currency are reported as unknown, not dropped", async () => {
  // Omitting value from a financial aggregate is worse than reporting it
  // unattributed — the total would silently understate what moved.
  const orphan = {
    id: "44444444-0000-4000-8000-00000000000d",
    team_id: TEAM_A,
    status: "confirmed",
    payload: "\\x00",
    intent_sender: "SenderA",
    tx_signature: "sigA3",
    intent_fee: "0.03",
    intent_total: "3.03",
    intent_currency: null,
  };
  const { client } = fakeSupabase([orphan]);
  const metrics = await getOpsMetricsForTeam(client, TEAM_A);

  assert.equal(metrics.by_currency.unknown.transfer_total, "3.03");
  assert.equal(metrics.by_currency.unknown.fees_collected, "0.03");
});

// ─── Route-layer guarantees, asserted statically ───

const ROUTES = readFileSync(
  join(fileURLToPath(new URL(".", import.meta.url)), "routes.ts"),
  "utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("409 conflict responses gate jobId and status on ownership", () => {
  // Dedup and replay lookups stay deliberately global — a payload hash or
  // (sender, nonce) pair must be single-use across all teams or replay
  // protection breaks. So the *response* must redact instead.
  //
  // Two conflict types (payload hash, nonce replay) x two submission paths
  // (v1 envelope, legacy base64) = four guards in routes.ts.
  const ownJobGuards = ROUTES.match(/ownJob\s*\?\s*\{\s*jobId:/g) ?? [];
  assert.equal(
    ownJobGuards.length,
    4,
    "both conflict types in both the v1 and legacy paths must gate jobId/status behind ownJob",
  );
});

test("no conflict response emits jobId unconditionally", () => {
  // A bare `jobId: existing.id` outside an ownJob guard would reinstate the leak.
  const unguarded = ROUTES.match(/^\s+jobId:\s*(existing|nonceReplay)\.id,/gm) ?? [];
  assert.equal(
    unguarded.length,
    0,
    `found ${unguarded.length} unguarded conflict jobId disclosure(s): ${unguarded.join(", ")}`,
  );
});

test("ops endpoints declare their scoping decision in a comment", () => {
  // The prompt requires the team-scoped vs internal-only choice to be explicit
  // at the route, so a later reader knows it was decided rather than defaulted.
  const withComments = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "routes.ts"),
    "utf-8",
  );
  assert.match(
    withComments,
    /Scoped to the calling team[\s\S]{0,400}\/v1\/ops\/metrics/,
    "/v1/ops/metrics must document its scoping decision",
  );
  assert.match(
    withComments,
    /Scoped to the calling team[\s\S]{0,400}\/v1\/ops\/transactions/,
    "/v1/ops/transactions must document its scoping decision",
  );
});
