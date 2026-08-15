import { z } from "zod";

/**
 * The environment `pnpm migrate` needs, and nothing else.
 *
 * Migrations talk to Postgres and log; they never sign, broadcast, queue, or
 * page. Validating the full schema for them meant `pnpm migrate` demanded
 * FEE_PAYER_SECRET_KEY, RPC_URLS, and RELAYER_INTENT_DOMAIN before it would open
 * a connection — so CI could not run migrations without being handed a
 * production signing key it had no use for, and a fresh clone could not create
 * its schema until every unrelated variable was filled in. That is
 * to-be-fixed.md issue 3.
 *
 * The full schema is built by extending this one rather than repeating these
 * three fields, so the rules a migration enforces are by construction the same
 * ones the server enforces. Declaring them twice would let the two drift, and a
 * migration connecting under weaker rules than the API is exactly the kind of
 * difference that stays invisible until it matters.
 */
const migrationEnvSchema = z.object({
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1),
  /**
   * Skip Postgres TLS certificate verification.
   *
   * An escape hatch for a managed pooler whose chain Node cannot verify without
   * an explicit CA bundle. The connection stays encrypted but the server is no
   * longer authenticated, so it is interceptable — `createPool` warns on every
   * startup when this is on. Leave unset unless a connection genuinely fails
   * verification.
   */
  DATABASE_SSL_NO_VERIFY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /**
   * CA bundle used to verify the Postgres server certificate.
   *
   * Either an inline PEM or a path to a `.crt` file. Supabase's pooler presents
   * a chain rooted in Supabase's own CA, which is not in Node's trust store, so
   * a verified connection fails with SELF_SIGNED_CERT_IN_CHAIN until that root
   * is supplied here. Get it from Supabase → Project Settings → Database → SSL
   * Configuration → Download certificate.
   *
   * This is the setting that makes DATABASE_SSL_NO_VERIFY unnecessary: it keeps
   * certificate verification on and simply teaches Node who to trust, rather
   * than turning the check off.
   */
  DATABASE_CA_CERT: z.string().optional(),
});

const envSchema = migrationEnvSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),

  REDIS_URL: z.string().url().default("redis://localhost:6379"),

  RPC_URLS: z
    .string()
    .transform((s) => s.split(",").map((u) => u.trim()).filter(Boolean))
    .refine((arr) => arr.length > 0, "At least one RPC URL required"),
  RPC_CONFIRMATION_COMMITMENT: z
    .enum(["processed", "confirmed", "finalized"])
    .default("confirmed"),
  RPC_CONFIRMATION_TIMEOUT_MS: z.coerce.number().default(60_000),

  RATE_LIMIT_MAX: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),

  BULL_CONCURRENCY: z.coerce.number().default(5),
  BULL_MAX_ATTEMPTS: z.coerce.number().default(5),
  BULL_BACKOFF_MS: z.coerce.number().default(1000),

  FEE_PAYER_SECRET_KEY: z.string().min(1),
  /**
   * Fee-payer keys being rotated out.
   *
   * One key: the same JSON byte array as FEE_PAYER_SECRET_KEY, e.g. the
   * contents of the old keyfile. Several: an array of those,
   * `[[1,2,...],[3,4,...]]`. Not comma-separated — a JSON byte array is itself
   * full of commas.
   *
   * A client bakes the fee payer's public key into the message it signs, so
   * swapping FEE_PAYER_SECRET_KEY alone permanently invalidates every
   * already-signed transaction naming the old key — and with a 120-day intent
   * TTL that window is enormous. Listing the old key here keeps it honoured for
   * in-flight work while new transactions use the current key. Remove it once
   * the queue has drained. See OPERATIONS.md.
   */
  FEE_PAYER_LEGACY_SECRET_KEYS: z.string().optional(),
  /**
   * The key users approve as delegate over their token accounts.
   *
   * Separate from `FEE_PAYER_SECRET_KEY` on purpose, and the separation is the
   * security property. The fee payer only ever spends the relayer's own SOL on
   * transaction fees and rent. This key can move **other people's tokens**, up
   * to whatever allowance each user approved. Collapsing the two would give one
   * environment variable both roles, so a leak of the key that merely pays fees
   * would also drain every delegated balance.
   *
   * Same JSON byte-array format as the fee payer. Its public key must be the
   * account users actually approved (`delegateUSDCAuthority` in zypp-pay) —
   * an SPL approval names exactly one delegate and does not carry over, so
   * rotating this key requires every user to re-approve. Treat rotation as a
   * migration, not a config change.
   *
   * Optional so the API and worker boot without it: the service is fully
   * functional for everything except relayer-constructed transfers, and
   * construction refuses loudly when it is absent rather than the whole process
   * failing to start.
   */
  DELEGATE_SECRET_KEY: z.string().optional(),
  USDC_MINT_ADDRESS: z.string().optional(),
  HOT_WALLET_ADDRESS: z.string().optional(),
  RELAYER_INTENT_DOMAIN: z.string().min(1),
  RELAYER_API_KEY: z.string().min(1).optional(),
  PUBLIC_RPC_URL: z.string().url().optional(),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_WEBHOOK_SECRET: z.string().optional(),

  // Circuit-breaker alerting (Telegram). Optional — when absent, breaker trips
  // are logged but nothing is paged. The token must come from the Render
  // environment, not a committed file.
  TELEGRAM_BOT_TOKEN: z.string().optional(),

  // Destination chat. Validated because the only failure mode here is silent:
  // an unusable value is accepted at startup, the notifier reports itself
  // configured, and the breach is only discovered when a real breaker trip
  // fires into a 400 that nobody is reading. This setting was in exactly that
  // state — set to the bot's own username, which can never receive a message.
  //
  // Accepted forms:
  //   - numeric user id      e.g.  123456789   (positive)
  //   - numeric group/channel e.g. -1001234567890 (negative)
  //   - @publicchannelname   — public channels and supergroups only
  //
  // What this CANNOT catch, and why: a private user cannot be addressed by
  // @username (the Bot API exposes no lookup from a personal handle to a chat),
  // but a personal handle and a public channel's handle are syntactically
  // identical. No shape rule separates them, so `@dbulbld` parses fine here and
  // fails at delivery. The bot-suffix rule below works only because it is a
  // genuine syntactic signal.
  //
  // Validation therefore narrows the failure surface; it does not close it.
  // Confirming a real message arrives (`scripts/tg-check.sh send`) is the only
  // proof of delivery — see OPERATIONS.md.
  TELEGRAM_ALERT_CHAT_ID: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || /^-?\d+$/.test(v) || /^@[A-Za-z0-9_]{5,}$/.test(v),
      { message: "must be a numeric chat id or an @username for a public channel" },
    )
    .refine((v) => v === undefined || !/bot$/i.test(v), {
      message:
        "points at a bot username — a bot cannot message itself, so no alert would ever be delivered. " +
        "Use your numeric user id (message the bot, then read it from getUpdates) or a group/channel id.",
    }),
});

export type Config = z.infer<typeof envSchema>;

/** The environment the migration entrypoint validates. A subset of {@link Config}. */
export type MigrationConfig = z.infer<typeof migrationEnvSchema>;

/**
 * What `createPool` actually reads.
 *
 * Stated as a Pick rather than the whole Config so the pool cannot quietly grow
 * a dependency on a field the migration path does not validate — that would
 * reintroduce issue 3 through the back door, and the type would catch it here.
 */
export type DatabaseConfig = Pick<
  Config,
  "DATABASE_URL" | "DATABASE_SSL_NO_VERIFY" | "DATABASE_CA_CERT"
>;

/**
 * The chat-id rule, exported so it can be tested without constructing a whole
 * valid environment. Kept as the single definition the schema also uses, so a
 * passing test cannot diverge from what startup actually enforces.
 */
export const telegramChatIdSchema = envSchema.shape.TELEGRAM_ALERT_CHAT_ID;

export function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid config:", parsed.error.flatten());
    throw new Error("Invalid environment configuration");
  }
  return parsed.data;
}

/**
 * Validate only what a migration run needs. See {@link migrationEnvSchema}.
 *
 * Deliberately not `loadConfig()` — a migration that refuses to start over a
 * missing signing key reports a problem that does not exist, and the real one
 * (an unreachable or unset DATABASE_URL) is the thing worth failing loudly on.
 */
export function loadMigrationConfig(): MigrationConfig {
  const parsed = migrationEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid migration config:", parsed.error.flatten());
    throw new Error("Invalid environment configuration for migrations");
  }
  return parsed.data;
}
