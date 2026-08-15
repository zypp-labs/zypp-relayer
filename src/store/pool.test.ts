import test from "node:test";
import assert from "node:assert/strict";
import { createPool } from "./pool.js";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";

/**
 * The connection itself cannot be unit-tested without a database, so these
 * cover the part that is pure logic: refusing a URL that is known not to
 * resolve, and not refusing one that might.
 *
 * The retired-host check exists because `ENOTFOUND db.<ref>.supabase.co` says
 * nothing about the cause. It cost a debugging session once (to-be-fixed.md
 * issue 6), and the failure recurs on every fresh clone that copies an old
 * `.env`.
 */

const warnings: unknown[][] = [];

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: (...args: unknown[]) => {
    warnings.push(args);
  },
  error: () => undefined,
} as never as Logger;

function configWith(url: string, noVerify = false, caCert?: string): Config {
  return {
    DATABASE_URL: url,
    DATABASE_SSL_NO_VERIFY: noVerify,
    DATABASE_CA_CERT: caCert,
  } as never as Config;
}

/** Shape only — never parsed here, since createPool passes it straight to pg. */
const FAKE_PEM =
  "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

/** A pooler URL of the shape the project actually runs on. Credentials are fake. */
const POOLER_URL =
  "postgresql://postgres.abc123:p@aws-1-eu-west-3.pooler.supabase.com:6543/postgres";

test("REFUSES a retired Supabase direct-connection host", () => {
  assert.throws(
    () => createPool(configWith("postgresql://u:p@db.hpwbugplcmqozghqgaah.supabase.co:5432/postgres"), log),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // The remedy has to be in the message — that is the entire point of
      // catching this here rather than letting DNS fail.
      assert.match(err.message, /pooler/i, "must name the pooler as the fix");
      assert.match(err.message, /Supabase/, "must say where to get the new URI");
      return true;
    },
  );
});

test("the refusal does not leak the password", () => {
  try {
    createPool(configWith("postgresql://user:sup3rs3cret@db.abc123.supabase.co:5432/postgres"), log);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(
      !err.message.includes("sup3rs3cret"),
      "a config error must not put credentials into logs or stack traces",
    );
  }
});

test("accepts a pooler host", () => {
  const pool = createPool(
    configWith("postgresql://postgres.abc123:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres"),
    log,
  );
  assert.ok(pool);
  void pool.end();
});

test("accepts a pooler host in a region other than aws-0", () => {
  // The real project runs on aws-1-eu-west-3. The numeric prefix is assigned per
  // project, so a check or a remedy message that assumes aws-0 is wrong for most
  // of them — this pins that the guard keys on the retired `db.<ref>` shape and
  // not on anything about the pooler's own naming.
  const pool = createPool(
    configWith("postgresql://postgres.abc123:p@aws-1-eu-west-3.pooler.supabase.com:6543/postgres"),
    log,
  );
  assert.ok(pool);
  void pool.end();
});

test("accepts a non-Supabase host", () => {
  // Local development and self-hosted Postgres must not be caught by a check
  // aimed at one provider's retired hostnames.
  const pool = createPool(configWith("postgresql://u:p@localhost:5432/zypp"), log);
  assert.ok(pool);
  void pool.end();
});

test("an unparseable URL is left to pg rather than second-guessed", () => {
  // Refusing here would report the wrong cause for a malformed value.
  const pool = createPool(configWith("not-a-url"), log);
  assert.ok(pool);
  void pool.end();
});

test("disabling certificate verification WARNS — it must not be silent", () => {
  warnings.length = 0;
  const pool = createPool(configWith("postgresql://u:p@localhost:5432/zypp", true), log);
  assert.equal(warnings.length, 1, "an unauthenticated TLS connection must be announced");
  const message = JSON.stringify(warnings[0]);
  assert.match(message, /NOT verified|interception/i);
  void pool.end();
});

test("verification on by default produces no warning", () => {
  warnings.length = 0;
  const pool = createPool(configWith("postgresql://u:p@localhost:5432/zypp", false), log);
  assert.equal(warnings.length, 0);
  void pool.end();
});

// ─── CA bundle ───
//
// Supabase's pooler is signed by Supabase's own root, which Node does not trust,
// so a verified connection fails with SELF_SIGNED_CERT_IN_CHAIN. Supplying the
// bundle is the fix that keeps verification ON; DATABASE_SSL_NO_VERIFY is the
// fallback that turns it off.

test("an inline PEM is used as the CA and needs no file", () => {
  warnings.length = 0;
  const pool = createPool(
    configWith(POOLER_URL, false, FAKE_PEM),
    log,
  );
  assert.ok(pool);
  assert.equal(warnings.length, 0, "supplying a CA is the correct setup, not a downgrade");
  void pool.end();
});

test("a CA path that does not exist FAILS rather than falling back", () => {
  // Falling back to the default trust store would connect on a machine where the
  // file happens to exist and fail on one where it does not — or verify against
  // roots the operator did not choose.
  assert.throws(
    () => createPool(configWith(POOLER_URL, false, "/nonexistent/prod-ca-2021.crt"), log),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /DATABASE_CA_CERT/, "must name the setting at fault");
      assert.match(err.message, /Download certificate|SSL Configuration/, "must say where to get it");
      return true;
    },
  );
});

test("a CA bundle OVERRIDES DATABASE_SSL_NO_VERIFY, and says so", () => {
  // The contradictory environment. Honouring the flag would silently discard a
  // working bundle and leave the connection interceptable, so the secure setting
  // wins — but it must not do that silently, or the operator keeps believing
  // verification is off.
  warnings.length = 0;
  const pool = createPool(configWith(POOLER_URL, true, FAKE_PEM), log);
  assert.equal(warnings.length, 1, "ignoring an explicit setting has to be announced");
  assert.match(JSON.stringify(warnings[0]), /IGNORING DATABASE_SSL_NO_VERIFY/);
  void pool.end();
});

test("the CA failure does not leak the password", () => {
  // Same reasoning as the retired-host case: this error is thrown during startup
  // and will be logged.
  try {
    createPool(
      configWith(
        "postgresql://user:sup3rs3cret@aws-1-eu-west-3.pooler.supabase.com:6543/postgres",
        false,
        "/nonexistent/ca.crt",
      ),
      log,
    );
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes("sup3rs3cret"));
  }
});
