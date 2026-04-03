import { VersionedTransaction } from "@solana/web3.js";
import type { Logger } from "../lib/logger.js";
import { MAX_TX_SIZE } from "../lib/constants.js";
import { sha256Base64 } from "../lib/hash.js";

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
