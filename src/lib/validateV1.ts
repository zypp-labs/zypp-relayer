import { z } from "zod";
import { createHash } from "node:crypto";
import type { Logger } from "../lib/logger.js";
import { INTENT_TYPES_REQUIRING_TRANSACTION } from "./constants.js";

const v1SignatureSchema = z.object({
  publicKey: z.string().min(1),
  signature: z.string().min(1),
  nonce: z.number().int().positive(),
});

const v1EnvelopeSchema = z.object({
  version: z.literal(1),
  network: z.literal("solana"),
  intent: z.string().min(1),
  payload: z.record(z.unknown()),
  signature: v1SignatureSchema.optional(),
  transaction: z.string().min(1).optional(),
  /**
   * Unix seconds at which the SDK queued the intent on-device. Optional: a
   * client built before timestamping omits it, and those are accepted with no
   * age check rather than rejected.
   */
  issuedAt: z.number().int().positive().optional(),
}).strict();

/**
 * How old a queued intent may be and still be settled.
 *
 * The intent is a durable record of user consent; the transaction that settles
 * it is built fresh at sync time (a Solana blockhash lives ~60–90s, so it
 * cannot be built at queue time and survive). Consent itself does expire, and
 * this is the outer bound on it: 120 days is a deliberately long window for
 * offline-first devices — a device stored in a drawer for months, a battery
 * that dies on a trip — while still keeping the authorization finite rather
 * than indefinite.
 *
 * 120 days was chosen to give real offline-first headroom without making the
 * signed intent effectively a standing authorization. Tunable via
 * INTENT_MAX_AGE_SECONDS.
 */
export const DEFAULT_INTENT_MAX_AGE_SECONDS = 120 * 24 * 60 * 60;

/**
 * Tolerance for a client clock running ahead of the relayer's.
 *
 * `issuedAt` comes from the device, and phone clocks drift or are set by hand.
 * Without slack, a device a minute fast would have every intent rejected as
 * "issued in the future". Five minutes absorbs ordinary skew; beyond that the
 * timestamp is not trustworthy enough to reason about age.
 */
export const INTENT_FUTURE_SKEW_SECONDS = 5 * 60;

export type IntentFreshness =
  | { fresh: true }
  | { fresh: false; code: "INTENT_EXPIRED" | "INTENT_ISSUED_IN_FUTURE"; message: string };

/**
 * Judge whether an intent is recent enough to settle.
 *
 * Accepts when `issuedAt` is absent — an older client cannot report age, and
 * refusing those would break every pre-upgrade install. The check is advisory
 * on that path and enforced on clients that do report.
 */
export function checkIntentFreshness(
  issuedAt: number | undefined,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  maxAgeSeconds: number = DEFAULT_INTENT_MAX_AGE_SECONDS,
): IntentFreshness {
  if (issuedAt === undefined) return { fresh: true };

  const ageSeconds = nowSeconds - issuedAt;

  if (ageSeconds < -INTENT_FUTURE_SKEW_SECONDS) {
    return {
      fresh: false,
      code: "INTENT_ISSUED_IN_FUTURE",
      message:
        `Intent claims to have been issued ${Math.abs(ageSeconds)}s in the future, beyond the ` +
        `${INTENT_FUTURE_SKEW_SECONDS}s clock-skew allowance. Check the device clock.`,
    };
  }

  if (ageSeconds > maxAgeSeconds) {
    const ageDays = Math.floor(ageSeconds / 86_400);
    const maxDays = Math.floor(maxAgeSeconds / 86_400);
    return {
      fresh: false,
      code: "INTENT_EXPIRED",
      message:
        `Intent was queued ${ageDays} day(s) ago, past the ${maxDays}-day limit. ` +
        "Re-confirm the payment with the user and submit a new intent.",
    };
  }

  return { fresh: true };
}

export type V1Envelope = z.infer<typeof v1EnvelopeSchema>;

export interface V1ValidationResult {
  ok: true;
  envelope: V1Envelope;
  txBytes: Buffer | null;
  payloadHash: string;
}

export interface V1ValidationError {
  ok: false;
  code: string;
  message: string;
}

function computePayloadHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(payload, Object.keys(payload).sort());
  return createHash("sha256").update(canonical).digest("hex");
}

function computeTxHash(txBytes: Buffer): string {
  return createHash("sha256").update(txBytes).digest("hex");
}

export function validateV1Envelope(input: unknown, _log: Logger): V1ValidationResult | V1ValidationError {
  const parsed = v1EnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      code: "INVALID_ENVELOPE",
      message: `Invalid v1 envelope: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    };
  }

  const envelope = parsed.data;

  if (envelope.intent === "payment" && !envelope.signature) {
    return {
      ok: false,
      code: "SIGNATURE_REQUIRED",
      message: "Payment intents require a signature",
    };
  }

  const requiresTx = INTENT_TYPES_REQUIRING_TRANSACTION.has(envelope.intent);

  // If the intent type requires a transaction, it must be present
  if (requiresTx && !envelope.transaction) {
    return {
      ok: false,
      code: "TRANSACTION_REQUIRED",
      message: `${envelope.intent} intents require a transaction field`,
    };
  }

  // Decode transaction bytes if present; null otherwise
  let txBytes: Buffer | null = null;
  if (envelope.transaction) {
    try {
      txBytes = Buffer.from(envelope.transaction, "base64");
    } catch {
      return {
        ok: false,
        code: "INVALID_TRANSACTION_BASE64",
        message: "Transaction field must be valid base64",
      };
    }

    if (txBytes.length === 0) {
      return {
        ok: false,
        code: "EMPTY_TRANSACTION",
        message: "Transaction bytes are empty after base64 decode",
      };
    }
  }

  // For intents with transactions, hash the transaction bytes for
  // content-addressed dedup. The tx bytes fully encode the economic
  // parameters (amount, recipient, asset), unlike the JSON payload
  // which is thin (just { intentType }) due to native queue limits.
  // For non-transaction intents, fall back to the JSON payload hash.
  const payloadHash = txBytes
    ? computeTxHash(txBytes)
    : computePayloadHash(envelope.payload);

  return {
    ok: true,
    envelope,
    txBytes,
    payloadHash,
  };
}
