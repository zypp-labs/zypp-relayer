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
}).strict();

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
