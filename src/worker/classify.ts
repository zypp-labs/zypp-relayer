/**
 * Classify RPC/send errors into retriable (transient) vs permanent.
 * Aligns with whitepaper: retry on RPC timeout, node unavailability, blockhash expiration;
 * do not retry on invalid signature, instruction failure, insufficient funds.
 */
export type ErrorCategory = "retriable" | "permanent";

const BLOCKHASH_EXPIRED_PATTERNS = [
  /blockhash.*expired/i,
  /block height exceeded/i,
  /blockhash not found/i,
  /has been expired/i,
];

const INSUFFICIENT_FUNDS_PATTERNS = [
  /insufficient funds/i,
  /insufficient lamports/i,
  /could not find a sufficient balance/i,
];

const INSTRUCTION_FAILURE_PATTERNS = [
  /instruction failed/i,
  /custom program error/i,
  /0x1/,
  /0x0/,
];

const INVALID_SIGNATURE_PATTERNS = [
  /invalid signature/i,
  /signature verification failed/i,
];

export function classifyError(error: unknown): ErrorCategory {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (BLOCKHASH_EXPIRED_PATTERNS.some((p) => p.test(message))) return "retriable";
  if (INSUFFICIENT_FUNDS_PATTERNS.some((p) => p.test(message))) return "permanent";
  if (INSTRUCTION_FAILURE_PATTERNS.some((p) => p.test(message))) return "permanent";
  if (INVALID_SIGNATURE_PATTERNS.some((p) => p.test(message))) return "permanent";

  if (lower.includes("timeout") || lower.includes("econnrefused") || lower.includes("enotfound")) return "retriable";
  if (lower.includes("503") || lower.includes("502") || lower.includes("504")) return "retriable";

  return "retriable";
}
