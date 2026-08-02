import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * B1 regression guard: every job read served to an API caller must be
 * team-scoped.
 *
 * The relayer leaked cross-tenant data through five read paths — the two by-id
 * endpoints, the SSE stream, and both /v1/ops/* endpoints — because they called
 * store helpers that apply no `team_id` filter. `/v1/ops/transactions` was the
 * dangerous one: it returned every tenant's recent jobs including
 * `intent_sender` and `tx_signature`, and the job ids it disclosed then unlocked
 * the by-id endpoints for any holder of a valid API key.
 *
 * The unscoped helpers still exist for the worker, which legitimately processes
 * jobs on the system's behalf with no requesting team. This test asserts the
 * route layer never reaches for them, which a reviewer can otherwise reintroduce
 * with a single plausible-looking import.
 *
 * Static source analysis rather than integration coverage: it needs no database
 * or network, and it catches the mistake at the point it is made.
 */

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** Unscoped store reads that must never appear in the API layer. */
const UNSCOPED_READS = ["getJobById", "getOpsMetrics", "getRecentJobs"];

function readSource(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), "utf-8");
}

/** Strip comments so prose naming a function does not register as a call. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("API routes never call unscoped job reads", () => {
  const src = stripComments(readSource("api/routes.ts"));

  for (const fn of UNSCOPED_READS) {
    // Word-boundary right side excludes the ForTeam variants.
    const called = new RegExp(`\\b${fn}\\s*\\(`).test(src);
    assert.equal(
      called,
      false,
      `api/routes.ts calls ${fn}(), which applies no team_id filter.\n` +
        `Use ${fn}ForTeam(..., request.teamId!) instead — serving an unscoped\n` +
        "read to an API caller exposes other tenants' jobs.",
    );

    const imported = new RegExp(`\\b${fn}\\b(?!ForTeam)`).test(
      src.slice(0, src.indexOf("export async function registerRoutes")),
    );
    assert.equal(
      imported,
      false,
      `api/routes.ts imports ${fn}. Remove the import so it cannot be used —` +
        ` the scoped ${fn}ForTeam variant is the only correct choice here.`,
    );
  }
});

test("every API job read passes a team id", () => {
  const src = stripComments(readSource("api/routes.ts"));

  const scopedCalls = [...src.matchAll(/getJobByIdForTeam\s*\(([^)]*)\)/g)];
  assert.ok(
    scopedCalls.length >= 3,
    `Expected at least 3 getJobByIdForTeam calls (two by-id endpoints and the ` +
      `SSE stream); found ${scopedCalls.length}. Did an endpoint lose its scoping?`,
  );

  for (const [, args] of scopedCalls) {
    assert.match(
      args,
      /teamId/,
      `getJobByIdForTeam called without a teamId argument: (${args.trim()})`,
    );
  }
});

test("worker retains the unscoped read", () => {
  // The counterpart to the assertions above: the worker SHOULD use the unscoped
  // helper. If this fails, someone has scoped the worker to a team, which would
  // silently stop it processing jobs.
  const src = stripComments(readSource("worker/index.ts"));
  assert.match(
    src,
    /\bgetJobById\s*\(/,
    "worker/index.ts no longer calls getJobById(). The worker acts for the " +
      "system, not a team, and must read jobs unscoped.",
  );
});

test("relayer settles payment intents only", () => {
  // E1: the acknowledge-and-close branch was removed, so any intent type absent
  // from INTENT_TYPES_REQUIRING_TRANSACTION must be rejected rather than
  // persisted. A reintroduced insert path would accept an unverified
  // intent_sender, since non-payment intents carry no verified signature.
  const src = stripComments(readSource("api/routes.ts"));

  assert.match(
    src,
    /INTENT_TYPE_NOT_YET_SUPPORTED/,
    "The 501 guard for non-payment intents is missing from api/routes.ts.",
  );

  assert.equal(
    /status:\s*["']acknowledged["']/.test(src),
    false,
    "api/routes.ts writes a job with status 'acknowledged'. That branch was " +
      "removed deliberately — see to-be-fixed.md E1. The enum value is " +
      "retained for forward compatibility but must not be written.",
  );
});
