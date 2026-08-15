import { readFileSync } from "node:fs";
import pg from "pg";
import type { DatabaseConfig } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";

const { Pool } = pg;

/**
 * Supabase retired direct-connection hostnames (`db.<ref>.supabase.co`) for
 * newer projects in favour of the Supavisor pooler
 * (`aws-0-<region>.pooler.supabase.com`). A URL still pointing at the old host
 * fails DNS resolution, which surfaces as a bare `ENOTFOUND` from deep inside
 * `pg` with nothing naming the cause.
 */
const RETIRED_DIRECT_HOST = /^db\.[a-z0-9]+\.supabase\.co$/i;

/**
 * Resolve DATABASE_CA_CERT to PEM text.
 *
 * Accepts the certificate inline or as a path, because the two deployment
 * targets want different things: Render holds multi-line PEM in an env var,
 * while a local checkout points at the downloaded `.crt`.
 *
 * A configured-but-unreadable bundle throws instead of falling back to the
 * default trust store. The fallback would connect successfully on the machine
 * where the file is present and fail on the one where it is missing — or worse,
 * verify against the wrong roots and appear to work.
 */
function resolveCaCert(value: string): string {
  if (value.includes("BEGIN CERTIFICATE")) {
    return value;
  }
  try {
    return readFileSync(value, "utf-8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `DATABASE_CA_CERT is set to '${value}', which is neither inline PEM nor a ` +
        `readable file: ${reason}. Supply the certificate contents directly, or a ` +
        "path to the bundle from Supabase → Project Settings → Database → SSL " +
        "Configuration → Download certificate.",
    );
  }
}

/**
 * Read the host out of a connection string without exposing the credentials in
 * it. Returns null when the URL is unparseable, leaving `pg` to complain about
 * a malformed value rather than second-guessing it here.
 */
function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return null;
  }
}

export function createPool(config: DatabaseConfig, log: Logger): pg.Pool {
  const host = hostOf(config.DATABASE_URL);

  if (host && RETIRED_DIRECT_HOST.test(host)) {
    // Fail at construction naming the remedy, rather than at first query with a
    // DNS error that says nothing about why. This exact misconfiguration is
    // to-be-fixed.md issue 6.
    throw new Error(
      `DATABASE_URL points at '${host}', a direct-connection hostname Supabase has ` +
        "retired — it will not resolve. Take the current URI from Supabase → Project " +
        "Settings → Database → Connection string → Transaction pooler. It looks like " +
        "postgresql://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:6543/postgres " +
        "— the aws-<n> prefix varies by project, so copy it rather than assuming aws-0.",
    );
  }

  // Supabase requires TLS on every connection, and `pg` does not enable it from
  // the connection string alone: `?sslmode=require` is accepted but does not
  // enforce certificate verification, which yields an encrypted channel with no
  // authentication of the peer.
  //
  // Three cases, in order of preference:
  //
  //   1. A CA bundle is supplied — verify against it. Supabase's pooler is
  //      signed by Supabase's own root, absent from Node's trust store, so a
  //      verified connection fails with SELF_SIGNED_CERT_IN_CHAIN until this is
  //      set. This is the case that makes the downgrade below unnecessary.
  //   2. Nothing supplied — verify against Node's defaults. Correct for a
  //      provider using a public CA, and for local Postgres with TLS off it is
  //      simply unused.
  //   3. DATABASE_SSL_NO_VERIFY — encrypted but unauthenticated, hence the
  //      warning on every startup.
  //
  // A CA wins over the no-verify flag when both are set. Preferring the flag
  // would silently discard a working bundle and downgrade the connection; this
  // way the safe configuration is the one that survives a contradictory
  // environment, and the ignored flag is reported rather than obeyed.
  const ca = config.DATABASE_CA_CERT ? resolveCaCert(config.DATABASE_CA_CERT) : undefined;
  const verify = ca !== undefined || !config.DATABASE_SSL_NO_VERIFY;

  const ssl = ca
    ? { rejectUnauthorized: true, ca }
    : { rejectUnauthorized: verify };

  if (ca && config.DATABASE_SSL_NO_VERIFY) {
    log.warn(
      { host },
      "Both DATABASE_CA_CERT and DATABASE_SSL_NO_VERIFY are set. Verifying against " +
        "the supplied CA and IGNORING DATABASE_SSL_NO_VERIFY — a usable bundle makes " +
        "the downgrade unnecessary. Unset DATABASE_SSL_NO_VERIFY to silence this.",
    );
  } else if (config.DATABASE_SSL_NO_VERIFY) {
    log.warn(
      { host },
      "DATABASE_SSL_NO_VERIFY is set — the Postgres connection is encrypted but the " +
        "server certificate is NOT verified, leaving it open to interception. Set " +
        "DATABASE_CA_CERT to the provider's bundle and unset this as soon as possible.",
    );
  }

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    ssl,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => log.error({ err }, "Postgres pool error"));
  return pool;
}
