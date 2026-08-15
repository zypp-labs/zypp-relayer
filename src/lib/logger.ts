import pino from "pino";

/**
 * Paths scrubbed from every log line.
 *
 * Defence in depth, not the primary control. Nothing in the codebase logs the
 * config object today — `loadConfig` reports only zod field *names* on failure,
 * and the two entrypoints log single scalars. But `registerRoutes` receives the
 * whole `Config` in its deps and Fastify attaches its own serializers, so one
 * `log.info({ config })` or one `log.error({ err })` carrying a stack with the
 * key interpolated would leak the fee payer's private key to whatever ships
 * these logs off-box.
 *
 * `censor` is left at pino's default `[Redacted]` so a redaction is visible in
 * the output rather than looking like an absent field.
 */
const REDACTED_PATHS = [
  "FEE_PAYER_SECRET_KEY",
  "*.FEE_PAYER_SECRET_KEY",
  "config.FEE_PAYER_SECRET_KEY",
  "feePayerSecretKey",
  "*.feePayerSecretKey",
  // Legacy fee-payer keys are live signing material during a rotation — a
  // draining key still moves money, so it needs the same treatment as the
  // current one.
  "FEE_PAYER_LEGACY_SECRET_KEYS",
  "*.FEE_PAYER_LEGACY_SECRET_KEYS",
  // Highest-value secret in the process: it can move *users'* tokens up to
  // whatever each has approved, where the fee payer only spends the relayer's
  // own SOL.
  "DELEGATE_SECRET_KEY",
  "*.DELEGATE_SECRET_KEY",
  "config.DELEGATE_SECRET_KEY",
  "delegateSecretKey",
  "*.delegateSecretKey",
  "secretKey",
  "*.secretKey",
  "SUPABASE_SERVICE_ROLE_KEY",
  "*.SUPABASE_SERVICE_ROLE_KEY",
  "DATABASE_URL",
  "*.DATABASE_URL",
  "POLAR_ACCESS_TOKEN",
  "*.POLAR_ACCESS_TOKEN",
  "POLAR_WEBHOOK_SECRET",
  "*.POLAR_WEBHOOK_SECRET",
  "RELAYER_API_KEY",
  "*.RELAYER_API_KEY",
  // Telegram bot token — grants full control of the alert bot.
  "TELEGRAM_BOT_TOKEN",
  "*.TELEGRAM_BOT_TOKEN",
  "botToken",
  "*.botToken",
  // Inbound tenant credential. Hashed before any store lookup, but the raw
  // header would otherwise appear in request logging.
  'req.headers["x-api-key"]',
  "headers.x-api-key",
];

export function createLogger(level: string = "info") {
  return pino({
    level,
    redact: { paths: REDACTED_PATHS, remove: false },
    ...(process.env.NODE_ENV === "development"
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  });
}

export type Logger = pino.Logger;

/** Exported for the test that pins this list against config's secret fields. */
export const REDACTED_LOG_PATHS = REDACTED_PATHS;
