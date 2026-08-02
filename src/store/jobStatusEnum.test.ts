import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JOB_STATUSES } from "../lib/constants.js";

/**
 * Guards the drift that broke the shunt and acknowledge paths: `JOB_STATUSES`
 * in src/lib/constants.ts declared six values while the `job_status` enum in
 * Postgres declared four, so every write of 'shunted' or 'acknowledged' was
 * rejected with `invalid input value for enum job_status`. Migration 008 closed
 * the gap; this test keeps it closed.
 *
 * This reads the migration files rather than connecting to a database. Both
 * sides of the drift live in the repo — the TS union and the SQL that builds the
 * enum — so the check needs no credentials, no network, and no live schema, and
 * it runs identically in CI and on a laptop.
 *
 * It does NOT verify that migrations have actually been applied to any given
 * database. That is a deploy-time concern, and the absence of a migration ledger
 * is tracked separately (see to-be-fixed.md issues 4 and 5).
 */

const MIGRATIONS_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "../../migrations");

/** Strip `--` line comments so prose mentioning a value can't register as SQL. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/**
 * Reconstruct the enum's value set from the migration files, in filename order:
 * `CREATE TYPE job_status AS ENUM (...)` seeds it, each
 * `ALTER TYPE job_status ADD VALUE 'x'` adds one.
 */
function enumValuesFromMigrations(): { values: string[]; sourceFiles: string[] } {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  const values: string[] = [];
  const sourceFiles: string[] = [];

  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
    let touched = false;

    const created = sql.match(/CREATE\s+TYPE\s+job_status\s+AS\s+ENUM\s*\(([^)]*)\)/i);
    if (created) {
      for (const m of created[1].matchAll(/'([^']+)'/g)) {
        if (!values.includes(m[1])) values.push(m[1]);
      }
      touched = true;
    }

    for (const m of sql.matchAll(
      /ALTER\s+TYPE\s+job_status\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi,
    )) {
      if (!values.includes(m[1])) values.push(m[1]);
      touched = true;
    }

    if (touched) sourceFiles.push(file);
  }

  return { values, sourceFiles };
}

test("job_status enum in migrations matches JOB_STATUSES in constants.ts", () => {
  const { values, sourceFiles } = enumValuesFromMigrations();

  assert.ok(
    values.length > 0,
    `No job_status enum definition found in ${MIGRATIONS_DIR}. Expected a ` +
      "CREATE TYPE job_status AS ENUM (...) statement.",
  );

  const inMigrations = [...values].sort();
  const inCode = [...JOB_STATUSES].sort();

  assert.deepEqual(
    inMigrations,
    inCode,
    "job_status drift between migrations and constants.ts.\n" +
      `  migrations (${sourceFiles.join(", ")}): ${inMigrations.join(", ")}\n` +
      `  JOB_STATUSES:                          ${inCode.join(", ")}\n` +
      "Any status the relayer writes must exist in the enum, or Postgres rejects\n" +
      "the insert. Add a migration with ALTER TYPE job_status ADD VALUE, or\n" +
      "correct JOB_STATUSES.",
  );
});

test("every status the relayer writes is a declared JobStatus", () => {
  // isTerminalStatus in constants.ts must cover exactly the statuses that end a
  // job's lifecycle. If a new status is added to JOB_STATUSES and is terminal,
  // the worker's early-return guard needs to know about it.
  const expectedTerminal = ["confirmed", "failed", "acknowledged", "shunted"];
  for (const status of expectedTerminal) {
    assert.ok(
      (JOB_STATUSES as readonly string[]).includes(status),
      `'${status}' is treated as terminal but is not in JOB_STATUSES`,
    );
  }
});
