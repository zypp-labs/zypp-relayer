import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Logger } from "../lib/logger.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/**
 * Where the runner looks unless told otherwise.
 *
 * Resolved from this module's own location rather than `process.cwd()`, because
 * the compiled entrypoint runs as `dist/store/run-migrate.js` from whatever
 * directory the platform happens to pick. `../../migrations` is correct from
 * both `src/store/` and `dist/store/`, which is why the Dockerfile has to copy
 * `migrations/` to `/app/migrations` and not somewhere alongside `dist`.
 */
export const DEFAULT_MIGRATIONS_DIR = join(__dirname, "../../migrations");

/**
 * Marker a migration can carry to opt out of the wrapping transaction.
 *
 * Some statements cannot run inside one — `CREATE INDEX CONCURRENTLY`, `VACUUM`,
 * and on older servers `ALTER TYPE ... ADD VALUE`. 008 documents hitting exactly
 * this class of constraint, so the escape hatch is here rather than waiting for
 * the next author to discover the runner cannot express what they need.
 *
 * Such a file gives up atomicity: a failure halfway through leaves its changes
 * applied but unrecorded, and the next run replays it. Write those idempotently.
 *
 * It also gives up the concurrency guard. The advisory lock below is
 * transaction-scoped, so a file with no transaction takes no lock, and two
 * runners starting together can both execute it. The alternative — a
 * session-scoped `pg_advisory_lock` — is not usable here (see
 * {@link MIGRATION_LOCK_KEY}), and claiming the row before running the body
 * would trade a replay for the worse failure of a migration recorded as applied
 * that never ran. No migration carries this marker today; if one does, apply it
 * from a single runner.
 */
const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

/**
 * Fixed key for the advisory lock serialising migration runs.
 *
 * `pg_advisory_xact_lock` rather than the session-level `pg_advisory_lock`,
 * because this connects through Supabase's transaction pooler: a session lock
 * is bound to a backend the pooler may hand to someone else between statements,
 * so it would silently fail to exclude anything.
 */
const MIGRATION_LOCK_KEY = 4_023_986_142;

const TRACKING_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

/**
 * Apply any migration that has not run yet.
 *
 * Previously every `.sql` file was re-executed on every invocation. That held
 * together only because all nine happened to be idempotent — the next author to
 * write a plain `ALTER TABLE ... ADD COLUMN`, an `INSERT` of seed rows, or a
 * backfill `UPDATE` would have had it re-run on each deploy. That is
 * to-be-fixed.md issue 4.
 *
 * Each file is claimed and applied inside one transaction, so "the change" and
 * "the record that it happened" commit together; a crash mid-run cannot leave
 * the two disagreeing. The advisory lock makes concurrent runners safe, which
 * matters now that this can be wired to a deploy hook where two instances may
 * start at once.
 *
 * **First run against an existing database replays every file.** The tracking
 * table starts empty, so it cannot know 001-009 were applied by hand. All nine
 * are idempotent, so this is safe here — but check that before adopting this on
 * another database with history.
 *
 * `migrationsDir` defaults to {@link DEFAULT_MIGRATIONS_DIR}; it is a parameter
 * so the tests can drive a controlled set of files, including the cases no real
 * migration exercises yet (a failing body, a `no-transaction` file).
 */
export async function migrate(
  pool: pg.Pool,
  log: Logger,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<void> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  await pool.query(TRACKING_TABLE_DDL);

  let applied = 0;
  let skipped = 0;

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const checksum = checksumOf(sql);
    const inTransaction = !sql.includes(NO_TRANSACTION_MARKER);

    const client = await pool.connect();
    try {
      if (inTransaction) {
        await client.query("BEGIN");
        // Inside the transaction, so it releases on COMMIT or ROLLBACK — including
        // the rollback an uncaught error triggers.
        await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
      }

      const { rows } = await client.query<{ checksum: string }>(
        "SELECT checksum FROM schema_migrations WHERE filename = $1",
        [file],
      );

      if (rows.length > 0) {
        // Applied already. Verify the file has not changed underneath us: an
        // edit to an applied migration runs on fresh databases but never on
        // existing ones, so environments diverge with nothing to show for it.
        if (rows[0].checksum !== checksum) {
          throw new Error(
            `Migration ${file} has been modified since it was applied ` +
              `(recorded ${rows[0].checksum.slice(0, 12)}, now ${checksum.slice(0, 12)}). ` +
              "Databases that already ran it will never see the change, so this file and " +
              "those databases have diverged. Write a new migration with the difference " +
              "instead of editing this one. If the edit was cosmetic and the SQL is " +
              "unchanged in effect, update the recorded checksum by hand.",
          );
        }
        if (inTransaction) await client.query("COMMIT");
        skipped++;
        continue;
      }

      log.info({ file }, "Running migration");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)",
        [file, checksum],
      );

      if (inTransaction) await client.query("COMMIT");
      applied++;
    } catch (err) {
      if (inTransaction) {
        // Best-effort: the transaction may already be aborted, and the original
        // error is the one worth reporting.
        await client.query("ROLLBACK").catch(() => undefined);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  log.info({ applied, skipped, total: files.length }, "Migrations complete");
}
