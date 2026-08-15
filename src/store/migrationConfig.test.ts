import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrationConfig, loadConfig } from "../lib/config.js";

/**
 * Issue 3: `pnpm migrate` validated the entire relayer environment.
 *
 * Migrations open a Postgres connection and run SQL. They never sign, broadcast,
 * enqueue, or alert — yet the entrypoint called `loadConfig()`, so the whole
 * schema had to pass before the first statement ran. The practical cost was that
 * CI could not migrate a database without being given a production fee-payer
 * signing key it had no use for, and a fresh clone could not create its schema
 * until every unrelated variable was populated.
 *
 * These tests set `process.env` directly. `loadMigrationConfig` reads it at call
 * time, so each case restores what it changed rather than relying on ordering.
 */

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const POOLER_URL =
  "postgresql://postgres.abc123:pw@aws-0-eu-west-2.pooler.supabase.com:6543/postgres";

/**
 * Run `fn` against exactly `env`, with everything else removed.
 *
 * A developer's real environment, or a loaded .env, would otherwise satisfy the
 * very variables these tests assert are unnecessary — the suite would pass while
 * the bug was fully present.
 */
function withOnlyEnv<T>(env: Record<string, string>, fn: () => T): T {
  const saved = process.env;
  process.env = { ...env } as NodeJS.ProcessEnv;
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

test("migrations need only a DATABASE_URL", () => {
  // The regression this closes. Every variable the old path demanded is absent.
  const config = withOnlyEnv({ DATABASE_URL: POOLER_URL }, loadMigrationConfig);

  assert.equal(config.DATABASE_URL, POOLER_URL);
  assert.equal(config.LOG_LEVEL, "info", "LOG_LEVEL should default rather than be required");
  assert.equal(config.DATABASE_SSL_NO_VERIFY, false, "TLS verification stays on by default");
});

test("a migration does NOT require a fee-payer signing key", () => {
  // Stated as its own test because this is the specific coupling that made CI
  // impossible: a schema change needed a production signing key to deploy.
  assert.doesNotThrow(
    () => withOnlyEnv({ DATABASE_URL: POOLER_URL }, loadMigrationConfig),
    "migrations must not demand FEE_PAYER_SECRET_KEY, RPC_URLS, or RELAYER_INTENT_DOMAIN",
  );
});

test("the full server config still demands the operational variables", () => {
  // The counterpart. Narrowing the migration path must not have loosened what the
  // API and worker validate at startup — that would trade a CI annoyance for a
  // relayer that boots without a fee payer and fails at first broadcast.
  assert.throws(
    () => withOnlyEnv({ DATABASE_URL: POOLER_URL }, loadConfig),
    /Invalid environment configuration/,
    "loadConfig must still reject an environment with no fee payer or RPC URLs",
  );
});

test("migrations still fail loudly with no DATABASE_URL", () => {
  // Narrower validation, not absent validation. This is the one variable a
  // migration genuinely cannot proceed without.
  assert.throws(
    () => withOnlyEnv({}, loadMigrationConfig),
    /Invalid environment configuration for migrations/,
  );
});

test("the migration schema is a subset of the server schema", () => {
  // Both are parsed from the same declaration (envSchema extends
  // migrationEnvSchema), so a value accepted by one is accepted by the other.
  // Asserting it here means a future split into two literals — which could let
  // migrations connect under weaker TLS rules than the API — fails visibly.
  const full = withOnlyEnv(
    {
      DATABASE_URL: POOLER_URL,
      LOG_LEVEL: "warn",
      DATABASE_SSL_NO_VERIFY: "true",
      FEE_PAYER_SECRET_KEY: "[1,2,3]",
      RPC_URLS: "https://api.devnet.solana.com",
      RELAYER_INTENT_DOMAIN: "zypp-test",
    },
    loadConfig,
  );

  const migration = withOnlyEnv(
    {
      DATABASE_URL: POOLER_URL,
      LOG_LEVEL: "warn",
      DATABASE_SSL_NO_VERIFY: "true",
    },
    loadMigrationConfig,
  );

  for (const key of Object.keys(migration) as (keyof typeof migration)[]) {
    assert.deepEqual(
      migration[key],
      full[key],
      `${key} is parsed differently by the two schemas — they have drifted apart`,
    );
  }
});

test("the migration entrypoint does not load the full config", () => {
  // Source-level guard, in the style of tenantScoping.test.ts. `loadConfig` is
  // the obvious import to reach for and would silently restore the coupling; the
  // behavioural tests above would still pass, because they exercise the
  // functions rather than the entrypoint that calls them.
  const src = readFileSync(join(SRC, "store/run-migrate.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  assert.doesNotMatch(
    src,
    /\bloadConfig\b/,
    "run-migrate.ts calls loadConfig(), which validates the whole environment.\n" +
      "Use loadMigrationConfig() — migrations must not require a fee-payer key.",
  );
  assert.match(src, /\bloadMigrationConfig\b/);
});
