import { Connection } from "@solana/web3.js";
import type { Config } from "./config.js";
import type { Logger } from "./logger.js";
import { coSignAsFeePayerWithKeys, loadFeePayerKeypairs, type IntentEnvelope } from "./feePayer.js";

export interface ShuntSuccess {
  ok: true;
  signature: string;
}

export interface ShuntFailure {
  ok: false;
  error: string;
}

export async function processShunt(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  config: Config,
  log: Logger,
): Promise<ShuntSuccess | ShuntFailure> {
  const publicRpc = config.PUBLIC_RPC_URL;
  if (!publicRpc) {
    return { ok: false, error: "PUBLIC_RPC_URL not configured — shunt path unavailable" };
  }

  let keys: ReturnType<typeof loadFeePayerKeypairs>;
  try {
    keys = loadFeePayerKeypairs(config);
  } catch {
    return { ok: false, error: "FEE_PAYER_KEY_INVALID: Failed to parse fee payer secret key" };
  }

  const coSignResult = coSignAsFeePayerWithKeys(partiallySignedTx, intentEnvelope, keys.keypairs);
  if (!coSignResult.ok) {
    return {
      ok: false,
      error: `${coSignResult.failure.code}: ${coSignResult.failure.message}`,
    };
  }

  try {
    const connection = new Connection(publicRpc, { commitment: "confirmed" });
    const signature = await connection.sendRawTransaction(coSignResult.tx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
      maxRetries: 0,
    } as any);

    log.info({ signature, publicRpc }, "Shunt broadcast sent (no confirmation polling)");
    return { ok: true, signature };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn({ err: e, publicRpc }, "Shunt broadcast failed");
    return { ok: false, error: `SHUNT_BROADCAST_FAILED: ${msg}` };
  }
}
