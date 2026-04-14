import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import type { Logger } from "../lib/logger.js";
import { MAX_TX_SIZE } from "../lib/constants.js";
import { sha256Base64 } from "../lib/hash.js";
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { z } from "zod";

export interface ValidationResult {
  ok: true;
  payload: Buffer;
  payloadHash: string;
}

export interface ValidationError {
  ok: false;
  code: string;
  message: string;
}

const baseIntentSchema = z.object({
  id: z.string().min(1),
  sender: z.string().min(1),
  signature: z.string().min(1),
  timestamp: z.number().int().positive(),
  metadata: z
    .object({
      v: z.literal(1),
      app: z.literal("zypp-pay"),
      network: z.enum(["mainnet-beta", "devnet"]),
      chain: z.literal("solana"),
      hw: z.string().min(1),
    })
    .strict(),
}).strict();

const transferIntentSchema = baseIntentSchema.extend({
  type: z.string().optional(),
  receiver: z.string().min(1),
  amount: z.number().finite().positive(),
  fee: z.number().finite().nonnegative(),
  total: z.number().finite().positive(),
  nonce: z.string().min(1),
});

const usdcInitializationIntentSchema = baseIntentSchema.extend({
  type: z.literal("USDC_INITIALIZATION"),
  nonce: z.string().min(1),
});

const intentSchema = z.union([transferIntentSchema, usdcInitializationIntentSchema]);
const intentBundleSchema = z.object({ intent: intentSchema });

export type TransferIntent = z.infer<typeof transferIntentSchema>;
export type USDCInitializationIntent = z.infer<typeof usdcInitializationIntentSchema>;
export type ZyppIntent = TransferIntent | USDCInitializationIntent;
export interface ZyppIntentBundle {
  intent: ZyppIntent;
}

export function isTransferIntent(intent: ZyppIntent): intent is TransferIntent {
  return intent.type !== "USDC_INITIALIZATION";
}

function computeCanonicalIntentId(intent: TransferIntent): string {
  const canonicalBody = JSON.stringify({
    s: intent.sender,
    r: intent.receiver,
    a: intent.amount,
    f: intent.fee,
    t: intent.total,
    n: intent.nonce,
    ts: intent.timestamp,
  });
  return createHash("sha256").update(canonicalBody).digest("hex");
}

function computeCanonicalInitIntentId(intent: USDCInitializationIntent): string {
  const canonicalBody = JSON.stringify({
    type: intent.type,
    sender: intent.sender,
    nonce: intent.nonce,
    ts: intent.timestamp,
  });
  return createHash("sha256").update(canonicalBody).digest("hex");
}

function domainSeparatedIntentHash(intentDomain: string, intentId: string): Buffer {
  const digest = createHash("sha256")
    .update(`${intentDomain}:${intentId}`)
    .digest();
  return Buffer.from(digest);
}

function isRecentTimestamp(timestamp: number): boolean {
  const now = Date.now();
  const MAX_PAST_MS = 1000 * 60 * 60 * 24 * 30;
  const MAX_FUTURE_MS = 1000 * 60 * 5;
  return timestamp >= now - MAX_PAST_MS && timestamp <= now + MAX_FUTURE_MS;
}

function isValidPublicKey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function hasMaxUsdcPrecision(value: number): boolean {
  return Number(value.toFixed(6)) === value;
}

function validateIntentInvariants(intent: ZyppIntent): ValidationError | null {
  if (!/^[a-f0-9]{64}$/i.test(intent.id)) {
    return { ok: false, code: "INVALID_INTENT_ID_FORMAT", message: "Intent ID must be a 64-char hex SHA-256 hash" };
  }

  if (!isValidPublicKey(intent.sender)) {
    return { ok: false, code: "INVALID_SENDER", message: "Intent sender must be a valid Solana public key" };
  }

  const sigBytes = Buffer.from(intent.signature, "base64");
  if (sigBytes.length !== 64) {
    return { ok: false, code: "INVALID_SIGNATURE_FORMAT", message: "Intent signature must be a valid Ed25519 signature" };
  }

  if (!isRecentTimestamp(intent.timestamp)) {
    return { ok: false, code: "INVALID_TIMESTAMP", message: "Intent timestamp is out of allowed range" };
  }

  if (isTransferIntent(intent)) {
    if (!isValidPublicKey(intent.receiver)) {
      return { ok: false, code: "INVALID_RECEIVER", message: "Intent receiver must be a valid Solana public key" };
    }
    if (!hasMaxUsdcPrecision(intent.amount) || !hasMaxUsdcPrecision(intent.fee) || !hasMaxUsdcPrecision(intent.total)) {
      return { ok: false, code: "INVALID_PRECISION", message: "USDC values must have at most 6 decimal places" };
    }
    const expectedTotal = intent.amount + intent.fee;
    if (Math.abs(expectedTotal - intent.total) > 1e-9) {
      return { ok: false, code: "INVALID_TOTAL", message: "Intent total must equal amount + fee" };
    }
    const canonicalId = computeCanonicalIntentId(intent);
    if (canonicalId !== intent.id) {
      return { ok: false, code: "INVALID_INTENT_ID", message: "Intent ID does not match canonical payload hash" };
    }
  } else {
    const canonicalId = computeCanonicalInitIntentId(intent);
    if (canonicalId !== intent.id) {
      return { ok: false, code: "INVALID_INTENT_ID", message: "Intent ID does not match canonical payload hash" };
    }
  }

  return null;
}

export function parseIntentPayload(payload: Buffer): ValidationError | { ok: true; bundle: ZyppIntentBundle } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf-8"));
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "Intent bundle must be valid JSON" };
  }

  const bundleResult = intentBundleSchema.safeParse(parsed);
  if (!bundleResult.success) {
    return { ok: false, code: "INVALID_INTENT", message: "Intent bundle is missing required fields" };
  }

  const invariantError = validateIntentInvariants(bundleResult.data.intent);
  if (invariantError) {
    return invariantError;
  }

  return { ok: true, bundle: bundleResult.data };
}

export async function validateIntent(
  base64: string,
  log: Logger,
  intentDomain: string
): Promise<ValidationResult | ValidationError> {
  let payload: Buffer;
  try {
    payload = Buffer.from(base64, "base64");
  } catch {
    log.debug("Invalid base64 in intent payload");
    return { ok: false, code: "INVALID_BASE64", message: "Invalid base64 encoding" };
  }

  const parsed = parseIntentPayload(payload);
  if (!parsed.ok) {
    return parsed;
  }

  try {
    const { intent } = parsed.bundle;
    // Cryptographic verification of user signature
    const message = domainSeparatedIntentHash(intentDomain, intent.id);
    const signature = Buffer.from(intent.signature, "base64");
    const publicKey = new PublicKey(intent.sender).toBytes();

    const isValid = nacl.sign.detached.verify(message, signature, publicKey);
    if (!isValid) {
      return { ok: false, code: "INVALID_SIGNATURE", message: "User intent signature is invalid" };
    }

    // Intent ID acts as the unique hash for deduplication
    const payloadHash = intent.id;
    return { ok: true, payload, payloadHash };
  } catch {
    return { ok: false, code: "INVALID_INTENT", message: "Intent contains invalid key or signature encoding" };
  }
}

export function validateTransaction(
  base64: string,
  log: Logger
): ValidationResult | ValidationError {
  let payload: Buffer;
  try {
    payload = Buffer.from(base64, "base64");
  } catch {
    log.debug("Invalid base64 in transaction payload");
    return { ok: false, code: "INVALID_BASE64", message: "Invalid base64 encoding" };
  }
  if (payload.length === 0) {
    return { ok: false, code: "EMPTY_PAYLOAD", message: "Transaction payload is empty" };
  }
  if (payload.length > MAX_TX_SIZE) {
    return {
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: `Transaction exceeds max size of ${MAX_TX_SIZE} bytes`,
    };
  }
  try {
    const tx = VersionedTransaction.deserialize(payload);
    if (!tx.signatures || tx.signatures.length === 0) {
      return { ok: false, code: "NO_SIGNATURES", message: "Transaction has no signatures" };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.debug({ err: msg }, "Transaction deserialization failed");
    return {
      ok: false,
      code: "INVALID_TRANSACTION",
      message: "Invalid serialized transaction",
    };
  }
  const payloadHash = sha256Base64(payload);
  return { ok: true, payload, payloadHash };
}
