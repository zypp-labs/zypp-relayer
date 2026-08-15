import type { Logger } from "./logger.js";
import { formatBaseUnits } from "./spendCeilings.js";

/**
 * Circuit-breaker alerting via Telegram.
 *
 * A spend breaker that only writes to stdout is a breaker nobody sees. The
 * relayer's metering already went dark for weeks without anyone noticing (see
 * B2 in `to-be-fixed.md` — 58 failed jobs, zero credits ever consumed, found
 * only because an audit went looking), and repeating that on the component that
 * refuses payments would be worse.
 *
 * Destination is the `zypp_ceiling_alert_bot` bot posting into the "Zypp
 * Ceiling Alert" group. Token comes from `TELEGRAM_BOT_TOKEN`, set via
 * `fly secrets` — never committed, never logged (it is in the pino redact list).
 *
 * ## Alerting must never block or break a broadcast
 *
 * Delivery is best-effort and deliberately decoupled from the policy decision.
 * The breaker has already refused the transaction by the time this runs; if
 * Telegram is unreachable, the correct behaviour is to log loudly and carry on,
 * not to throw a second error over the top of the first. Every failure path
 * here ends in a log line, never a rejected promise.
 */

/** Context for a tripped breaker. Mirrors what is already structured-logged. */
export interface CircuitBreakerAlert {
  /**
   * Which guard refused.
   *
   * `sol_budget` differs from the other two: it is a *temporary* refusal that
   * the queue will retry, not a permanent rejection of a defective transaction.
   * The alert copy reflects that.
   */
  kind: "amount_ceiling" | "fee_payer_velocity" | "sol_budget";
  /** Machine-readable code from `SpendPolicyError`. */
  code: string;
  /** Job/intent identifier, for correlation with the jobs table. */
  intentId: string;
  /** Owning team. */
  teamId: string;
  /** Amount that triggered the refusal, in base units. */
  amount: bigint;
  /** Mint address, when known. Null for a bare Transfer. */
  asset: string | null;
  /**
   * The mint's decimal places, when resolved. Null when unknown — the alert
   * then reports raw base units rather than implying a magnitude it cannot
   * justify.
   */
  decimals?: number | null;
  /** The limit that was crossed, in the same units as `amount`. */
  threshold: bigint;
  /** Full human-readable reason from the policy error. */
  detail: string;
}

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

/** Escape for Telegram's MarkdownV2. Unescaped `.` or `-` rejects the message. */
function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/**
 * Compose the alert body.
 *
 * Wording is deliberate: the transaction is **rejected**, permanently. There is
 * no manual-review queue and none is planned, so the copy must not imply one —
 * "pending approval" would send someone hunting for a dashboard that does not
 * exist.
 */
/** Lamports rendered as SOL. Display only — budget maths stays in bigint. */
function formatLamports(lamports: bigint): string {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac} SOL` : `${whole} SOL`;
}

export function formatAlert(alert: CircuitBreakerAlert): string {
  const heading =
    alert.kind === "amount_ceiling"
      ? "🚫 Spend ceiling exceeded — transaction rejected"
      : alert.kind === "fee_payer_velocity"
        ? "🚫 Fee-payer velocity limit — broadcast halted"
        : "⏳ SOL budget exhausted — broadcast deferred";

  // A budget trip is measured in lamports, not in a token's base units, so it
  // formats as SOL directly rather than going through a mint lookup that would
  // report "asset unknown".
  const isBudget = alert.kind === "sol_budget";
  const decimals = alert.decimals ?? null;

  const amountLine = isBudget
    ? `${formatLamports(alert.amount)} (${alert.amount} lamports)`
    : alert.asset
      ? `${formatBaseUnits(alert.amount, alert.asset, decimals)} (${alert.amount} base units)`
      : `${alert.amount} base units (asset unknown)`;

  const thresholdLine = isBudget
    ? `${formatLamports(alert.threshold)} (${alert.threshold} lamports)`
    : alert.asset
      ? `${formatBaseUnits(alert.threshold, alert.asset, decimals)} (${alert.threshold} base units)`
      : `${alert.threshold} base units`;

  const assetLine = isBudget
    ? "*Cost:* fee-payer SOL \\(fees \\+ ATA rent\\)"
    : alert.asset
      ? `*Asset:* \`${escapeMarkdown(alert.asset)}\``
      : "*Asset:* unknown";

  // The closing line differs by kind because the required action differs. A
  // ceiling or velocity breach is permanent and the caller must change what they
  // send. A budget trip is temporary and the queue retries by itself — telling
  // an operator to reduce the amount would send them chasing a non-problem.
  const closing = isBudget
    ? "Temporary — the transaction stays queued and retries once the rolling window frees budget. " +
      "Investigate if this persists: it means sustained fee-payer spend."
    : "No approval workflow exists — the caller must submit a smaller amount.";

  const lines = [
    `*${escapeMarkdown(heading)}*`,
    "",
    `*Code:* \`${escapeMarkdown(alert.code)}\``,
    `*Intent:* \`${escapeMarkdown(alert.intentId)}\``,
    `*Team:* \`${escapeMarkdown(alert.teamId)}\``,
    `*Amount:* ${escapeMarkdown(amountLine)}`,
    `*Threshold:* ${escapeMarkdown(thresholdLine)}`,
    assetLine,
    "",
    escapeMarkdown(alert.detail),
    "",
    escapeMarkdown(closing),
  ];

  return lines.join("\n");
}

/** Sends breaker alerts. Swappable so tests need no network. */
export interface AlertNotifier {
  notify(alert: CircuitBreakerAlert): Promise<void>;
}

/** Notifier used when no destination is configured — logs and moves on. */
export class LoggingOnlyNotifier implements AlertNotifier {
  constructor(private readonly log: Logger) {}

  async notify(alert: CircuitBreakerAlert): Promise<void> {
    this.log.error(
      {
        alertKind: alert.kind,
        code: alert.code,
        intentId: alert.intentId,
        teamId: alert.teamId,
        amount: alert.amount.toString(),
        threshold: alert.threshold.toString(),
        asset: alert.asset,
        telegramConfigured: false,
      },
      "Circuit breaker tripped — no alert destination configured, logging only",
    );
  }
}

export class TelegramNotifier implements AlertNotifier {
  constructor(
    private readonly config: TelegramConfig,
    private readonly log: Logger,
    /** Injectable for tests; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
    /** Give up rather than hold a worker slot on a hung request. */
    private readonly timeoutMs = 5_000,
  ) {}

  async notify(alert: CircuitBreakerAlert): Promise<void> {
    // Always log first. If delivery fails the record still exists locally —
    // the log is the source of truth, Telegram is the notification.
    this.log.error(
      {
        alertKind: alert.kind,
        code: alert.code,
        intentId: alert.intentId,
        teamId: alert.teamId,
        amount: alert.amount.toString(),
        threshold: alert.threshold.toString(),
        asset: alert.asset,
      },
      "Circuit breaker tripped",
    );

    const url = `https://api.telegram.org/bot${this.config.botToken}/sendMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text: formatAlert(alert),
          parse_mode: "MarkdownV2",
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        // Read the body for the reason — Telegram explains rejections there
        // (bad chat_id, malformed markdown) and without it this is unfixable.
        const body = await response.text().catch(() => "<unreadable>");
        this.log.error(
          { status: response.status, body, intentId: alert.intentId },
          "Telegram alert delivery failed — breaker fired but nobody was notified",
        );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      // Never rethrow. The breaker already refused the transaction; a delivery
      // failure must not become a second error on top of the first.
      this.log.error(
        { err: reason, intentId: alert.intentId },
        "Telegram alert delivery threw — breaker fired but nobody was notified",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build a notifier from config.
 *
 * Falls back to logging-only when the token or chat id is absent, and says so
 * at startup — silently degrading to no alerting is how a breaker ends up
 * firing into the void.
 */
export function createAlertNotifier(
  config: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_ALERT_CHAT_ID?: string },
  log: Logger,
): AlertNotifier {
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_ALERT_CHAT_ID) {
    log.warn(
      {
        hasToken: Boolean(config.TELEGRAM_BOT_TOKEN),
        hasChatId: Boolean(config.TELEGRAM_ALERT_CHAT_ID),
      },
      "Telegram alerting not configured — circuit breaker trips will only be logged",
    );
    return new LoggingOnlyNotifier(log);
  }

  return new TelegramNotifier(
    { botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_ALERT_CHAT_ID },
    log,
  );
}
