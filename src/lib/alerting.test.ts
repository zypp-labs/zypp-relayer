import test from "node:test";
import assert from "node:assert/strict";
import {
  baseUnits,
  formatBaseUnits,
  DEFAULT_AMOUNT_CEILINGS,
  MINTS,
} from "./spendCeilings.js";
import { checkSpendPolicy, SpendPolicyError } from "./spendPolicy.js";
import {
  formatAlert,
  TelegramNotifier,
  LoggingOnlyNotifier,
  createAlertNotifier,
  type CircuitBreakerAlert,
} from "./alerting.js";
import { telegramChatIdSchema } from "./config.js";

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

// ─── The unit mistake this config exists to prevent ───

test("baseUnits accepts a correctly stated ceiling", () => {
  assert.equal(baseUnits(100, 6, 100_000_000n), 100_000_000n);
  assert.equal(baseUnits(1.2, 9, 1_200_000_000n), 1_200_000_000n);
});

test("baseUnits REJECTS whole units written where base units belong", () => {
  // The dangerous direction. A ceiling of `1.2` lamports blocks everything and
  // is at least loud; a ceiling of `100` where 100_000_000 was meant is
  // 10^6 too permissive and fails silently in the direction of overspending.
  assert.throws(
    () => baseUnits(100, 6, 100n),
    /100 at 6 decimals is 100000000 base units, but 100 was given/,
  );
});

test("baseUnits REJECTS a float-multiplication result", () => {
  // 1.2 * 1e9 evaluates to 1200000000.0000002 in IEEE 754 — exactly the error
  // this helper exists to catch, which is why it does string arithmetic.
  assert.throws(() => baseUnits(1.2, 9, 1_200_000_001n), /is 1200000000 base units/);
});

test("baseUnits REJECTS more precision than the mint has", () => {
  assert.throws(() => baseUnits(1.2345678, 6, 1_234_568n), /decimal places but the mint only has 6/);
});

test("baseUnits handles a whole number with no fractional part", () => {
  assert.equal(baseUnits(5, 9, 5_000_000_000n), 5_000_000_000n);
});

// ─── The configured ceilings ───

test("USDC ceiling is $100 in 6-decimal base units", () => {
  const usdc = DEFAULT_AMOUNT_CEILINGS.find((c) => c.asset === MINTS.USDC);
  assert.ok(usdc);
  assert.equal(usdc.maxAmount, 100_000_000n);
});

test("SOL ceiling is 1.2 SOL in lamports", () => {
  const sol = DEFAULT_AMOUNT_CEILINGS.find((c) => c.asset === MINTS.WSOL);
  assert.ok(sol);
  assert.equal(sol.maxAmount, 1_200_000_000n);
});

test("the configured ceilings admit a normal payment and refuse an oversized one", () => {
  // $99.99 passes, $100.01 does not.
  checkSpendPolicy({ amount: 99_990_000n, asset: MINTS.USDC }, DEFAULT_AMOUNT_CEILINGS);
  assert.throws(
    () => checkSpendPolicy({ amount: 100_010_000n, asset: MINTS.USDC }, DEFAULT_AMOUNT_CEILINGS),
    SpendPolicyError,
  );
});

test("an unlisted asset is still refused with the real ceilings", () => {
  // Fail-closed survives contact with the production config.
  assert.throws(
    () => checkSpendPolicy({ amount: 1n, asset: "SomeOtherMint" }, DEFAULT_AMOUNT_CEILINGS),
    /no spend ceiling configured/,
  );
});

// ─── Human-readable formatting (display only) ───

test("formats USDC and SOL amounts for alert copy", () => {
  assert.equal(formatBaseUnits(100_000_000n, MINTS.USDC, 6), "100 USDC");
  assert.equal(formatBaseUnits(99_990_000n, MINTS.USDC, 6), "99.99 USDC");
  assert.equal(formatBaseUnits(1_200_000_000n, MINTS.WSOL, 9), "1.2 SOL");
});

test("names an unlisted mint by address rather than mislabelling it", () => {
  // REGRESSION. The previous implementation was
  // `asset === MINTS.USDC ? "USDC" : "SOL"`, so every unlisted mint rendered as
  // "SOL" — an alert about an arbitrary token would have claimed it was SOL.
  const other = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const text = formatBaseUnits(5_000_000n, other, 6);
  assert.match(text, /7xKX…gAsU/, "an unlisted mint should be shown by abbreviated address");
  assert.doesNotMatch(text, /SOL/, "and must not be labelled SOL");
});

test("unknown decimals are reported as unknown, not assumed to be zero", () => {
  // The old fallback returned decimals 0, so 5_000_000 base units of a
  // 6-decimal token printed as "5000000" — five million times the real amount,
  // in the alert someone reads during an incident.
  const text = formatBaseUnits(5_000_000n, MINTS.USDC, null);
  assert.match(text, /decimals unknown/);
  assert.match(text, /5000000 base units/);
});

test("a genuinely indivisible token formats without a decimal point", () => {
  assert.equal(formatBaseUnits(42n, MINTS.USDC, 0), "42 USDC");
});

// ─── Alert content ───

const SAMPLE: CircuitBreakerAlert = {
  kind: "amount_ceiling",
  code: "AMOUNT_EXCEEDS_CEILING",
  intentId: "job-abc-123",
  teamId: "team-xyz-789",
  amount: 500_000_000n,
  asset: MINTS.USDC,
  decimals: 6,
  threshold: 100_000_000n,
  detail: "intent amount 500000000 exceeds configured ceiling 100000000",
};

test("the alert carries every field needed to investigate", () => {
  // Strip the MarkdownV2 escapes first. Asserting against the escaped form
  // couples every check to Telegram's escaping rules — `_` in a failure code
  // becomes `\_`, `-` in a uuid becomes `\-` — which is what broke this test.
  // What matters is the field reaching the reader, not how it is encoded.
  const text = formatAlert(SAMPLE).replace(/\\(.)/g, "$1");

  assert.match(text, /job-abc-123/, "intent id");
  assert.match(text, /team-xyz-789/, "team id");
  assert.match(text, /500000000/, "amount in base units");
  assert.match(text, /100000000/, "threshold");
  assert.match(text, /AMOUNT_EXCEEDS_CEILING/, "code");
  assert.match(text, new RegExp(MINTS.USDC), "asset");
});

test("the alert says rejected, never pending approval", () => {
  // No approval workflow exists or is planned. Copy implying one would send
  // someone hunting for a dashboard that does not exist.
  const text = formatAlert(SAMPLE).replace(/\\(.)/g, "$1");
  assert.match(text, /rejected/i);
  assert.match(text, /No approval workflow exists/);
  assert.doesNotMatch(text, /pending/i);
  assert.doesNotMatch(text, /await/i);
  assert.doesNotMatch(text, /review queue/i);
});

test("the alert shows both human and base-unit amounts", () => {
  // Base units are what the ceiling is enforced on; the human amount is for
  // whoever reads the alert at 3am.
  const text = formatAlert(SAMPLE).replace(/\\(.)/g, "$1");
  assert.match(text, /500 USDC/);
  assert.match(text, /500000000 base units/);
});

test("an alert without decimals says so rather than implying a magnitude", () => {
  // Callers that cannot resolve decimals must not have the alert silently
  // present base units as though they were whole tokens.
  const text = formatAlert({ ...SAMPLE, decimals: null }).replace(/\\(.)/g, "$1");
  assert.match(text, /decimals unknown/);
  assert.doesNotMatch(text, /500 USDC/, "must not claim a whole-token figure it cannot justify");
});

test("velocity alerts read as a halt, not a rejection of one payment", () => {
  const text = formatAlert({
    ...SAMPLE,
    kind: "fee_payer_velocity",
    code: "FEE_PAYER_VALUE_LIMIT",
  }).replace(/\\(.)/g, "$1");
  assert.match(text, /velocity limit/i);
  assert.match(text, /halted/i);
});

test("an unknown asset still produces a usable alert", () => {
  const text = formatAlert({ ...SAMPLE, asset: null }).replace(/\\(.)/g, "$1");
  assert.match(text, /asset unknown/i);
  assert.match(text, /500000000 base units/);
});

test("markdown metacharacters are escaped", () => {
  // An unescaped `.` or `-` makes Telegram reject the whole message, so the
  // alert would vanish exactly when it mattered.
  const text = formatAlert({ ...SAMPLE, intentId: "a.b-c_d" });
  assert.match(text, /a\\\.b\\-c\\_d/);
});

// ─── Delivery ───

function fakeFetch(impl: () => Promise<Response> | Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return impl();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const okResponse = () => new Response("{\"ok\":true}", { status: 200 });

test("posts to the Telegram sendMessage endpoint with the right chat", async () => {
  const { fn, calls } = fakeFetch(okResponse);
  const notifier = new TelegramNotifier({ botToken: "tok123", chatId: "-100999" }, silentLog, fn);
  await notifier.notify(SAMPLE);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bottok123/sendMessage");
  const body = calls[0].body as { chat_id: string; parse_mode: string; text: string };
  assert.equal(body.chat_id, "-100999");
  assert.equal(body.parse_mode, "MarkdownV2");
  assert.match(body.text, /job\\-abc\\-123/);
});

test("a Telegram HTTP error does NOT throw", async () => {
  // The breaker has already refused the transaction. A delivery failure must
  // not become a second error thrown over the top of the first.
  const { fn } = fakeFetch(() => new Response("Bad Request: chat not found", { status: 400 }));
  const notifier = new TelegramNotifier({ botToken: "t", chatId: "c" }, silentLog, fn);
  await notifier.notify(SAMPLE); // must resolve
});

test("a network failure does NOT throw", async () => {
  const { fn } = fakeFetch(() => {
    throw new Error("ENOTFOUND api.telegram.org");
  });
  const notifier = new TelegramNotifier({ botToken: "t", chatId: "c" }, silentLog, fn);
  await notifier.notify(SAMPLE);
});

test("a hung request does not hang the worker", async () => {
  // The fake must honour the abort signal the way real fetch does — a promise
  // that merely never settles is not a timeout test, it is a deadlock. The
  // first version of this test hung the whole suite.
  const hangUntilAborted = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () =>
        reject(new DOMException("This operation was aborted", "AbortError")),
      );
    })) as unknown as typeof fetch;

  const notifier = new TelegramNotifier({ botToken: "t", chatId: "c" }, silentLog, hangUntilAborted, 20);
  const started = Date.now();
  await notifier.notify(SAMPLE);
  assert.ok(Date.now() - started < 2000, "the abort timeout should have fired");
});

// ─── Notifier selection ───

test("returns a Telegram notifier when fully configured", () => {
  const notifier = createAlertNotifier(
    { TELEGRAM_BOT_TOKEN: "t", TELEGRAM_ALERT_CHAT_ID: "c" },
    silentLog,
  );
  assert.ok(notifier instanceof TelegramNotifier);
});

test("falls back to logging-only when the token is missing", () => {
  const notifier = createAlertNotifier({ TELEGRAM_ALERT_CHAT_ID: "c" }, silentLog);
  assert.ok(notifier instanceof LoggingOnlyNotifier);
});

test("falls back to logging-only when the chat id is missing", () => {
  const notifier = createAlertNotifier({ TELEGRAM_BOT_TOKEN: "t" }, silentLog);
  assert.ok(notifier instanceof LoggingOnlyNotifier);
});

test("the logging-only notifier resolves rather than throwing", async () => {
  await new LoggingOnlyNotifier(silentLog).notify(SAMPLE);
});

// ─── Chat-id validation ───
//
// This setting shipped pointing at the bot's own username, so every breaker trip
// since has fired into a 400 that nobody read. Config being present is not
// evidence alerts arrive, and the notifier cannot tell the difference — so the
// unusable shapes have to be rejected at startup instead.

test("a bot username is rejected — a bot cannot message itself", () => {
  const result = telegramChatIdSchema.safeParse("@zypp_ceiling_alert_bot");
  assert.equal(result.success, false);
});

test("a personal @username passes validation — shape cannot detect this, only delivery can", () => {
  // Not an endorsement: `@dbulbld` is undeliverable, because the Bot API exposes
  // no lookup from a personal handle to a chat. But a personal @username and a
  // public channel's @username are syntactically identical, so no shape rule can
  // separate them — rejecting one would reject the other, and public channels
  // are a legitimate destination.
  //
  // This is the boundary of what config validation can prove. The `bot` suffix
  // below is caught because it is a genuine syntactic signal; "is this a private
  // user" is not. Everything past this line is caught by sending a real message,
  // which is why `scripts/tg-check.sh send` is a required step and not a
  // convenience.
  assert.equal(telegramChatIdSchema.safeParse("@dbulbld").success, true);
});

test("an invite link is rejected — the hash is not a chat id", () => {
  const result = telegramChatIdSchema.safeParse("https://t.me/+70fxrMpzob9jZThk");
  assert.equal(result.success, false);
});

test("a negative group id is accepted", () => {
  assert.equal(telegramChatIdSchema.safeParse("-1001234567890").success, true);
});

test("a positive user id is accepted", () => {
  assert.equal(telegramChatIdSchema.safeParse("123456789").success, true);
});

test("a public channel @username is accepted", () => {
  assert.equal(telegramChatIdSchema.safeParse("@zypp_alerts_channel").success, true);
});

test("absent stays valid — alerting is optional and degrades to logging", () => {
  assert.equal(telegramChatIdSchema.safeParse(undefined).success, true);
});
