import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { migrate, DEFAULT_MIGRATIONS_DIR } from "./migrate.js";
import type { Logger } from "../lib/logger.js";

/**
 * Issue 4: the runner re-executed every `.sql` file on every invocation.
 *
 * It survived only because all nine migrations happen to be idempotent. The
 * first plain `ALTER TABLE ... ADD COLUMN`, seed `INSERT`, or backfill `UPDATE`
 * anyone wrote would have run again on each deploy — and now that a Render
 * pre-deploy hook can call this automatically, "each deploy" means every push.
 *
 * These run against a fake pool rather than Postgres: the behaviour under test
 * is which statements the runner issues and in what order, which is exactly what
 * a fake can observe and a real database mostly hides. The two things a fake
 * cannot check — that `pg_advisory_xact_lock` really excludes a second runner,
 * and that a rolled-back transaction really discards the DDL — are Postgres's
 * guarantees, not this module's.
 */

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never as Logger;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Postgres, reduced to what the runner touches.
 *
 * `applied` stands in for the `schema_migrations` table; `statements` is the
 * transcript every assertion below reads. Bodies are separated from control
 * statements at record time so a test can ask "did this file actually run?"
 * without re-parsing SQL.
 */
class FakePool {
  /** filename -> checksum. The tracking table. */
  readonly applied = new Map<string, string>();
  /** Every statement issued, in order, control and body alike. */
  readonly statements: string[] = [];
  /** Just the migration bodies, in order. */
  readonly bodies: string[] = [];
  connects = 0;
  releases = 0;
  /** A body containing this substring throws, standing in for a bad migration. */
  failOn: string | null = null;

  async query(text: string, values?: unknown[]) {
    return this.run(text, values);
  }

  async connect() {
    this.connects++;
    let released = false;
    return {
      query: (text: string, values?: unknown[]) => this.run(text, values),
      release: () => {
        // pg counts a double release as a bug worth throwing over; so does this,
        // because the `finally` that releases sits next to a rethrow.
        assert.ok(!released, "client released twice");
        released = true;
        this.releases++;
      },
    };
  }

  private async run(text: string, values?: unknown[]): Promise<{ rows: { checksum: string }[] }> {
    this.statements.push(text.trim());
    const sql = text.trim();

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(sql)) return { rows: [] };
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };

    if (/^SELECT checksum FROM schema_migrations/.test(sql)) {
      const recorded = this.applied.get(String(values?.[0]));
      return { rows: recorded === undefined ? [] : [{ checksum: recorded }] };
    }

    if (/^INSERT INTO schema_migrations/.test(sql)) {
      this.applied.set(String(values?.[0]), String(values?.[1]));
      return { rows: [] };
    }

    this.bodies.push(sql);
    if (this.failOn !== null && sql.includes(this.failOn)) {
      throw new Error('relation "widgets" already exists');
    }
    return { rows: [] };
  }

  asPool(): pg.Pool {
    return this as never as pg.Pool;
  }
}

/** Run `fn` against a throwaway migrations directory containing exactly `files`. */
async function withMigrations<T>(
  files: Record<string, string>,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "zypp-migrate-"));
  try {
    for (const [name, sql] of Object.entries(files)) {
      writeFileSync(join(dir, name), sql);
    }
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXTURES = {
  "001_a.sql": "CREATE TABLE widgets (id INT);\n",
  "002_b.sql": "ALTER TABLE widgets ADD COLUMN name TEXT;\n",
  "003_c.sql": "INSERT INTO widgets (id) VALUES (1);\n",
};

// ─── the fix ───

test("a second run applies NOTHING — this is the whole point of issue 4", async () => {
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();

    await migrate(pool.asPool(), log, dir);
    assert.deepEqual(pool.bodies, Object.values(FIXTURES).map((s) => s.trim()));

    pool.bodies.length = 0;
    await migrate(pool.asPool(), log, dir);
    assert.deepEqual(
      pool.bodies,
      [],
      "an already-applied migration re-ran; a non-idempotent INSERT would have duplicated its rows",
    );
  });
});

test("only the new migration runs when one is added", async () => {
  // The everyday case: three applied, a fourth arrives. Re-running the first
  // three is not merely wasteful, it is how a backfill UPDATE gets applied twice.
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    writeFileSync(join(dir, "004_d.sql"), "UPDATE widgets SET name = 'x';\n");
    pool.bodies.length = 0;
    await migrate(pool.asPool(), log, dir);

    assert.deepEqual(pool.bodies, ["UPDATE widgets SET name = 'x';"]);
  });
});

test("files are applied in filename order", async () => {
  // Load-bearing, not cosmetic: 009_ops_metrics_by_currency.sql redefines the
  // `get_ops_metrics()` that 004_supabase_rpcs.sql creates. Applied out of order,
  // the database silently ends up with the older definition.
  await withMigrations(
    { "010_j.sql": "SELECT 10;", "002_b.sql": "SELECT 2;", "001_a.sql": "SELECT 1;" },
    async (dir) => {
      const pool = new FakePool();
      await migrate(pool.asPool(), log, dir);
      assert.deepEqual(pool.bodies, ["SELECT 1;", "SELECT 2;", "SELECT 10;"]);
    },
  );
});

test("the tracking table is created before it is read", async () => {
  // Not an ordering nicety — the first SELECT against a database that has never
  // migrated would otherwise fail with `relation "schema_migrations" does not
  // exist`, making a fresh database the one case that cannot be set up.
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    const ddl = pool.statements.findIndex((s) =>
      s.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations"),
    );
    const firstRead = pool.statements.findIndex((s) =>
      s.startsWith("SELECT checksum FROM schema_migrations"),
    );
    assert.equal(ddl, 0, "the tracking table must be the first statement of a run");
    assert.ok(firstRead > ddl);
  });
});

test("non-SQL files in the directory are ignored", async () => {
  await withMigrations(
    { "001_a.sql": "SELECT 1;", "README.md": "notes", "002_b.sql.bak": "SELECT 99;" },
    async (dir) => {
      const pool = new FakePool();
      await migrate(pool.asPool(), log, dir);
      assert.deepEqual(pool.bodies, ["SELECT 1;"], "an editor backup must not be executed");
    },
  );
});

// ─── atomicity ───

test("the change and the record of it commit together", async () => {
  // If the INSERT landed outside the transaction, a crash between the two would
  // leave the schema changed and unrecorded (replayed next run) or recorded and
  // unchanged (never applied). Both are worse than failing.
  await withMigrations({ "001_a.sql": "CREATE TABLE widgets (id INT);" }, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    const order = pool.statements.slice(1).map((s) => s.split(" ").slice(0, 2).join(" "));
    assert.deepEqual(order, [
      "BEGIN",
      "SELECT pg_advisory_xact_lock($1)",
      "SELECT checksum",
      "CREATE TABLE",
      "INSERT INTO",
      "COMMIT",
    ]);
  });
});

test("a failing migration ROLLS BACK and is not recorded", async () => {
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();
    pool.failOn = "ADD COLUMN";

    await assert.rejects(() => migrate(pool.asPool(), log, dir), /widgets/);

    assert.ok(pool.statements.includes("ROLLBACK"), "the open transaction must be closed");
    assert.ok(
      !pool.applied.has("002_b.sql"),
      "a migration that threw must not be recorded, or it is skipped forever after",
    );
    assert.ok(pool.applied.has("001_a.sql"), "migrations that succeeded stay recorded");
  });
});

test("a failure stops the run rather than carrying on to later migrations", async () => {
  // Later files are written against the schema the earlier ones produce. Skipping
  // a failure and continuing turns one clear error into a cascade of confusing
  // ones, and can leave the schema in a state no migration describes.
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();
    pool.failOn = "ADD COLUMN";

    await assert.rejects(() => migrate(pool.asPool(), log, dir));
    assert.ok(
      !pool.bodies.some((b) => b.startsWith("INSERT INTO widgets")),
      "003 ran after 002 failed",
    );
  });
});

test("every connection is returned to the pool, success or failure", async () => {
  // A leaked client on the error path exhausts a small pool after a handful of
  // failed deploys, and the symptom is a hang rather than an error.
  await withMigrations(FIXTURES, async (dir) => {
    const ok = new FakePool();
    await migrate(ok.asPool(), log, dir);
    assert.equal(ok.connects, ok.releases);
    assert.ok(ok.connects > 0);

    const bad = new FakePool();
    bad.failOn = "ADD COLUMN";
    await assert.rejects(() => migrate(bad.asPool(), log, dir));
    assert.equal(bad.releases, bad.connects, "the client was leaked on the error path");
  });
});

test("the advisory lock is taken inside the transaction, before the check", async () => {
  // Two Render instances deploying at once both read "not applied" and both run
  // the file unless one waits. It must be `pg_advisory_xact_lock`, not the
  // session-level `pg_advisory_lock`: this connects through Supabase's
  // transaction pooler, which may hand the backend to another client between
  // statements — a session lock would be released or held by the wrong session.
  await withMigrations({ "001_a.sql": "SELECT 1;" }, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    const begin = pool.statements.indexOf("BEGIN");
    const lock = pool.statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    const check = pool.statements.findIndex((s) => s.startsWith("SELECT checksum"));

    assert.ok(lock > begin, "a lock taken outside the transaction releases at the wrong time");
    assert.ok(check > lock, "checking before locking is the race the lock exists to prevent");
    assert.ok(
      !pool.statements.some((s) => /pg_advisory_lock\b/.test(s)),
      "session-level locks are unreliable through a transaction pooler",
    );
  });
});

// ─── checksum drift ───

test("REFUSES to run when an applied migration has been edited", async () => {
  // Editing an applied file is silent divergence: fresh databases get the new
  // text, databases that already ran it never do, and nothing anywhere reports a
  // difference. Failing the deploy is the only moment this is visible.
  await withMigrations(FIXTURES, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    writeFileSync(join(dir, "002_b.sql"), "ALTER TABLE widgets ADD COLUMN label TEXT;\n");
    pool.bodies.length = 0;

    await assert.rejects(
      () => migrate(pool.asPool(), log, dir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /002_b\.sql/, "must name the file at fault");
        assert.match(err.message, /new migration/i, "must say what to do instead");
        return true;
      },
    );
    assert.deepEqual(pool.bodies, [], "the edited file must not be applied a second time");
  });
});

test("whitespace counts — the checksum is over the file, not its meaning", async () => {
  // Stated because it is a deliberate trade. A comment fix trips the guard, which
  // is annoying; the alternative is normalising SQL well enough to be sure two
  // texts mean the same thing, which is not a thing this runner can do correctly.
  // The error tells the operator how to accept a cosmetic edit by hand.
  await withMigrations({ "001_a.sql": "SELECT 1;\n" }, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    writeFileSync(join(dir, "001_a.sql"), "-- a note\nSELECT 1;\n");
    await assert.rejects(() => migrate(pool.asPool(), log, dir), /modified since it was applied/);
  });
});

test("the recorded checksum is the SHA-256 of the file's contents", async () => {
  // Pins the algorithm. Changing it would make every recorded row look like drift
  // on the next deploy, failing it everywhere at once.
  await withMigrations({ "001_a.sql": "SELECT 1;\n" }, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);
    assert.equal(pool.applied.get("001_a.sql"), sha256("SELECT 1;\n"));
  });
});

test("the drift error does not print the SQL it is complaining about", async () => {
  // Deploy logs are widely readable. A migration body can contain seed data or a
  // hostname; the two truncated hashes identify the mismatch without quoting it.
  await withMigrations({ "001_a.sql": "SELECT 'before';\n" }, async (dir) => {
    const pool = new FakePool();
    await migrate(pool.asPool(), log, dir);

    writeFileSync(join(dir, "001_a.sql"), "SELECT 'after';\n");
    await assert.rejects(
      () => migrate(pool.asPool(), log, dir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!err.message.includes("after"), "the error quoted the migration body");
        return true;
      },
    );
  });
});

// ─── the no-transaction escape hatch ───

test("`-- migrate:no-transaction` runs the file outside a transaction", async () => {
  // CREATE INDEX CONCURRENTLY and VACUUM cannot run inside one, and 008's header
  // documents hitting this class of constraint. Without the marker the runner
  // could not express what such a migration needs.
  await withMigrations(
    {
      "001_a.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON widgets (id);\n",
    },
    async (dir) => {
      const pool = new FakePool();
      await migrate(pool.asPool(), log, dir);

      assert.ok(!pool.statements.includes("BEGIN"), "the marker was ignored");
      assert.ok(!pool.statements.includes("COMMIT"));
      assert.ok(pool.bodies.some((b) => b.includes("CREATE INDEX CONCURRENTLY")));
      assert.ok(pool.applied.has("001_a.sql"), "it still has to be recorded, or it replays");
    },
  );
});

test("a no-transaction file takes NO lock — documented, not an oversight", async () => {
  // The lock is transaction-scoped, so a file that opts out of the transaction is
  // also opting out of the concurrency guard: two runners starting together can
  // both execute it. The alternatives are worse — a session-scoped lock is
  // unreliable through the pooler, and recording the row before running the body
  // trades a replay for a migration marked applied that never ran.
  //
  // Asserted so the gap is visible in the suite rather than discovered later.
  // Nothing in migrations/ carries the marker today.
  await withMigrations(
    { "001_a.sql": "-- migrate:no-transaction\nVACUUM widgets;\n" },
    async (dir) => {
      const pool = new FakePool();
      await migrate(pool.asPool(), log, dir);
      assert.ok(
        !pool.statements.some((s) => s.includes("advisory")),
        "if this now takes a lock, the comment in migrate.ts is stale",
      );
    },
  );
});

test("a no-transaction file that fails does not attempt a ROLLBACK", async () => {
  // There is no transaction to roll back; issuing one against an idle connection
  // logs a warning that reads like a second, unrelated fault.
  await withMigrations(
    { "001_a.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON widgets (id);\n" },
    async (dir) => {
      const pool = new FakePool();
      pool.failOn = "CREATE INDEX";
      await assert.rejects(() => migrate(pool.asPool(), log, dir));
      assert.ok(!pool.statements.includes("ROLLBACK"));
      assert.equal(pool.connects, pool.releases);
    },
  );
});

test("marked and unmarked files coexist in one run", async () => {
  await withMigrations(
    {
      "001_a.sql": "CREATE TABLE widgets (id INT);\n",
      "002_b.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY idx ON widgets (id);\n",
      "003_c.sql": "ALTER TABLE widgets ADD COLUMN name TEXT;\n",
    },
    async (dir) => {
      const pool = new FakePool();
      await migrate(pool.asPool(), log, dir);

      assert.equal(pool.applied.size, 3);
      assert.equal(
        pool.statements.filter((s) => s === "BEGIN").length,
        2,
        "exactly the two unmarked files should be wrapped",
      );
    },
  );
});

// ─── the real migrations ───

test("the nine real migrations are discovered and ordered 001..009", async () => {
  // Runs the actual directory through the runner. Catches a file added with a
  // name that sorts wrongly, and pins that 009 lands after the 004 it supersedes.
  const pool = new FakePool();
  await migrate(pool.asPool(), log, DEFAULT_MIGRATIONS_DIR);

  const onDisk = readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  assert.deepEqual([...pool.applied.keys()], onDisk);
  assert.ok(onDisk.length >= 9, "expected the existing migration set to still be present");

  const four = onDisk.indexOf("004_supabase_rpcs.sql");
  const nine = onDisk.indexOf("009_ops_metrics_by_currency.sql");
  assert.ok(nine > four, "009 redefines get_ops_metrics(); applied first, 004 would win");
});

test("a second pass over the real migrations is a no-op", async () => {
  // The state the production database is in after the first deploy that runs
  // this. Every subsequent deploy should touch nothing.
  const pool = new FakePool();
  await migrate(pool.asPool(), log, DEFAULT_MIGRATIONS_DIR);
  pool.bodies.length = 0;
  await migrate(pool.asPool(), log, DEFAULT_MIGRATIONS_DIR);
  assert.deepEqual(pool.bodies, []);
});

test("the real migrations are still idempotent, because the first run replays them", async () => {
  // The tracking table starts empty against the existing database, so the first
  // run re-executes 001-009 over a schema that already has them. That is only
  // safe while each file guards its own effect. A new migration without a guard
  // is fine *going forward* — but this assertion exists so the next author sees
  // the constraint, and a bare `CREATE TABLE` or `ADD COLUMN` fails here rather
  // than at 3am mid-deploy.
  const unguarded: string[] = [];
  for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(DEFAULT_MIGRATIONS_DIR, file), "utf-8");
    const stripped = sql.replace(/--[^\n]*/g, "");
    const guarded =
      /IF NOT EXISTS/i.test(stripped) ||
      /CREATE OR REPLACE/i.test(stripped) ||
      /EXCEPTION\s+WHEN\s+duplicate_object/i.test(stripped);
    if (!guarded) unguarded.push(file);
  }

  assert.deepEqual(
    unguarded,
    [],
    "these migrations have no IF NOT EXISTS / CREATE OR REPLACE / duplicate_object guard.\n" +
      "The first run of the tracking table replays every file against a database that\n" +
      "already has them, so an unguarded one will fail that deploy.",
  );
});
