import {
  Connection,
  Commitment,
  SendOptions,
  Keypair,
  Transaction as LegacyTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import { classifyError } from "./classify.js";
import { Buffer } from "buffer";
import { isTransferIntent, parseIntentPayload } from "../lib/validate.js";

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
}

export async function processIntentAndBroadcast(
  payload: Buffer,
  config: Config,
  log: Logger
): Promise<BroadcastResult | BroadcastFailure> {
  try {
    const parsed = parseIntentPayload(payload);
    if (!parsed.ok) {
      return {
        success: false,
        retriable: false,
        message: `${parsed.code}: ${parsed.message}`,
      };
    }
    const { intent } = parsed.bundle;

    const endpoints = config.RPC_URLS;
    const commitment = config.RPC_CONFIRMATION_COMMITMENT as Commitment;
    const connection = new Connection(endpoints[0], commitment);

    // 1. Setup Sponsor (Relayer)
    const sponsorKey = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(config.RELAYER_SECRET_KEY)));
    const usdcMint = new PublicKey(config.USDC_MINT_ADDRESS);
    const hotWallet = new PublicKey(config.HOT_WALLET_ADDRESS);
    const sender = new PublicKey(intent.sender);

    const { blockhash } = await connection.getLatestBlockhash();

    // Create the real transaction
    const tx = new LegacyTransaction({
      feePayer: sponsorKey.publicKey,
      recentBlockhash: blockhash,
    });

    // 2. Handle different intent types
    if (!isTransferIntent(intent)) {
      log.info({ userId: intent.sender }, "Processing gasless USDC initialization");
      const associatedTokenAddress = await getAssociatedTokenAddress(usdcMint, sender);

      tx.add(
        createAssociatedTokenAccountInstruction(
          sponsorKey.publicKey, // Payer (Relayer)
          associatedTokenAddress,
          sender,
          usdcMint
        )
      );
    } else {
      // Default: USDC Transfer
      const receiver = new PublicKey(intent.receiver);
      const senderAta = await getAssociatedTokenAddress(usdcMint, sender);
      const receiverAta = await getAssociatedTokenAddress(usdcMint, receiver);
      const hotWalletAta = await getAssociatedTokenAddress(usdcMint, hotWallet);

      // Use hotWallet (relayer) as the delegate authority
      tx.add(
        createTransferCheckedInstruction(
          senderAta,
          usdcMint,
          receiverAta,
          hotWallet, // Using relayer's hot wallet as delegate authority
          BigInt(Math.floor(intent.amount * 1_000_000)), // USDC 6 decimals
          6
        )
      );

      // Add Fee Transfer ($0.01)
      tx.add(
        createTransferCheckedInstruction(
          senderAta,
          usdcMint,
          hotWalletAta,
          hotWallet, // Using relayer's hot wallet as delegate authority
          BigInt(Math.floor(intent.fee * 1_000_000)),
          6
        )
      );
    }

    // 3. Combine Signatures
    tx.partialSign(sponsorKey);

    // Broadcast the assembled transaction
    return await broadcastWithFailover(tx.serialize(), config, log);
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
  log: Logger
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
        log
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
        };
      }
      log.warn({ err: e, endpoint }, "RPC attempt failed, trying next");
    }
  }

  return {
    success: false,
    retriable: true,
    message: lastError?.message ?? "All RPC endpoints failed",
    rpcEndpoint: lastEndpoint,
  };
}

async function tryBroadcastOne(
  endpoint: string,
  payload: Buffer,
  commitment: Commitment,
  timeoutMs: number,
  log: Logger
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
    return {
      success: false,
      retriable: category === "retriable",
      message: e instanceof Error ? e.message : String(e),
      rpcEndpoint: endpoint,
    };
  }

  const signature = rawSig;
  const confirmed = await waitForConfirmation(
    connection,
    signature,
    commitment,
    timeoutMs,
    log
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
    };
  }
  return {
    success: false,
    retriable: classifyError(confirmed) === "retriable",
    message: confirmed instanceof Error ? confirmed.message : String(confirmed),
    rpcEndpoint: endpoint,
  };
}

const CONFIRM_POLL_INTERVAL_MS = 1000;

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  _commitment: Commitment,
  timeoutMs: number,
  _log: Logger
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
