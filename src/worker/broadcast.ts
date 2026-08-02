import {
  Connection,
  Commitment,
  SendOptions,
  Keypair,
} from "@solana/web3.js";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { classifyError } from "./classify.js";
import { coSignAsFeePayer, type IntentEnvelope } from "../lib/feePayer.js";
import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "../lib/failureCodes.js";

export interface BroadcastResult {
  success: true;
  signature: string;
  rpcEndpoint: string;
}

export interface BroadcastFailure {
  success: false;
  retriable: boolean;
  message: string;
  rpcEndpoint?: string;
  failure?: RelayerFailure;
}

/**
 * Process an intent envelope by co-signing as fee payer and broadcasting.
 *
 * The caller (worker) extracts the partially-signed transaction and the
 * validated intent envelope from the job payload. This function:
 *
 *   1. Deserializes the user's partially-signed VersionedTransaction
 *   2. Calls coSignAsFeePayer() which enforces the verify-then-sign gate
 *      (steps 1-9 in feePayer.ts — user sig MUST verify before co-sign)
 *   3. Broadcasts the fully-signed transaction with RPC failover
 *
 * Unlike the v1 delegate-authority model, this function NEVER constructs
 * transaction instructions. The user supplies the fully-formed transaction;
 * the relayer only co-signs as fee payer and broadcasts.
 */
export async function processIntentAndBroadcast(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  config: Config,
  log: Logger,
): Promise<BroadcastResult | BroadcastFailure> {
  try {
    // Step A: Recover the fee payer keypair from config
    const feePayerKey = config.FEE_PAYER_SECRET_KEY;
    let feePayerKeypair: Keypair;
    try {
      const secretKey = Uint8Array.from(JSON.parse(feePayerKey));
      feePayerKeypair = Keypair.fromSecretKey(secretKey);
    } catch {
      return {
        success: false,
        retriable: false,
        message: "FEE_PAYER_KEY_INVALID: Failed to parse fee payer secret key from config",
      };
    }

    // Step B: Co-sign with verify-then-sign gate (HARD GATE)
    // If the user's signature is invalid, or the instructions don't
    // match the declared intent, or the blockhash is missing — this
    // returns { ok: false } and we never reach the broadcast step.
    const coSignResult = coSignAsFeePayer(
      partiallySignedTx,
      intentEnvelope,
      feePayerKeypair,
    );

    if (!coSignResult.ok) {
      log.warn(
        {
          stage: coSignResult.failure.stage,
          code: coSignResult.failure.code,
          message: coSignResult.failure.message,
        },
        "Fee-payer co-sign rejected",
      );
      return {
        success: false,
        retriable: coSignResult.failure.retriable,
        message: `${coSignResult.failure.code}: ${coSignResult.failure.message}`,
        failure: coSignResult.failure,
      };
    }

    // Step C: Broadcast with failover
    return await broadcastWithFailover(coSignResult.tx, config, log);
  } catch (e) {
    return {
      success: false,
      retriable: false,
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function broadcastWithFailover(
  payload: Buffer,
  config: Config,
  log: Logger,
): Promise<BroadcastResult | BroadcastFailure> {
  const endpoints = config.RPC_URLS;
  const commitment = config.RPC_CONFIRMATION_COMMITMENT as Commitment;
  const timeout = config.RPC_CONFIRMATION_TIMEOUT_MS;

  let lastError: Error | null = null;
  let lastEndpoint: string | undefined;

  for (const endpoint of endpoints) {
    try {
      const result = await tryBroadcastOne(
        endpoint,
        payload,
        commitment,
        timeout,
        log,
      );
      if (result.success) return result;
      if (!result.retriable) return result;
      lastError = new Error(result.message);
      lastEndpoint = result.rpcEndpoint ?? endpoint;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      lastEndpoint = endpoint;
      const category = classifyError(e);
      if (category === "permanent") {
        return {
          success: false,
          retriable: false,
          message: lastError.message,
          rpcEndpoint: endpoint,
          failure: relayerFailure(
            RelayerFailureStage.Broadcast,
            "BROADCAST_PERMANENT",
            lastError.message,
          ),
        };
      }
      log.warn({ err: e, endpoint }, "RPC attempt failed, trying next");
    }
  }

  const allFailedMsg = lastError?.message ?? "All RPC endpoints failed";
  return {
    success: false,
    retriable: true,
    message: allFailedMsg,
    rpcEndpoint: lastEndpoint,
    failure: relayerFailure(
      RelayerFailureStage.Broadcast,
      "ALL_RPCS_FAILED",
      allFailedMsg,
      true,
    ),
  };
}

async function tryBroadcastOne(
  endpoint: string,
  payload: Buffer,
  commitment: Commitment,
  timeoutMs: number,
  log: Logger,
): Promise<BroadcastResult | BroadcastFailure> {
  const connection = new Connection(endpoint, { commitment });

  let rawSig: string;
  try {
    rawSig = await connection.sendRawTransaction(payload, {
      skipPreflight: false,
      preflightCommitment: commitment,
      maxRetries: 0,
    } as SendOptions);
  } catch (e) {
    const category = classifyError(e);
    const message = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      retriable: category === "retriable",
      message,
      rpcEndpoint: endpoint,
      failure: relayerFailure(
        RelayerFailureStage.Broadcast,
        category === "retriable" ? "BROADCAST_TRANSIENT" : "BROADCAST_PERMANENT",
        message,
        category === "retriable",
      ),
    };
  }

  const signature = rawSig;
  const confirmed = await waitForConfirmation(
    connection,
    signature,
    commitment,
    timeoutMs,
    log,
  );

  if (confirmed === true) {
    log.debug({ signature, endpoint }, "Transaction confirmed");
    return { success: true, signature, rpcEndpoint: endpoint };
  }
  if (confirmed === "expired") {
    return {
      success: false,
      retriable: true,
      message: "Confirmation timed out (transaction may still land)",
      rpcEndpoint: endpoint,
      failure: relayerFailure(
        RelayerFailureStage.Confirmation,
        "CONFIRMATION_TIMEOUT",
        "Confirmation timed out (transaction may still land)",
        true,
      ),
    };
  }
  const confirmedMsg = confirmed instanceof Error ? confirmed.message : String(confirmed);
  return {
    success: false,
    retriable: classifyError(confirmed) === "retriable",
    message: confirmedMsg,
    rpcEndpoint: endpoint,
    failure: relayerFailure(
      RelayerFailureStage.Confirmation,
      "CONFIRMATION_FAILED",
      confirmedMsg,
      classifyError(confirmed) === "retriable",
    ),
  };
}

const CONFIRM_POLL_INTERVAL_MS = 1000;

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  _commitment: Commitment,
  timeoutMs: number,
  _log: Logger,
): Promise<true | "expired" | Error> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const statuses = await connection.getSignatureStatuses([signature]);
    const status = statuses.value[0];
    if (status) {
      if (status.err) return new Error(String(status.err));
      const conf = status.confirmationStatus;
      if (conf === "confirmed" || conf === "finalized") return true;
    }
    await new Promise((r) => setTimeout(r, CONFIRM_POLL_INTERVAL_MS));
  }
  return "expired";
}
