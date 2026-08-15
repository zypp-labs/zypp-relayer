import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Logger } from "./logger.js";
import type { Config } from "./config.js";
import { RelayerFailureStage, relayerFailure, type RelayerFailure } from "./failureCodes.js";
import { buildDelegatedTransfer, type FeeTransfer } from "./constructTransfer.js";
import { verifyConstructedTransaction, ConstructedTransactionMismatchError } from "./outboundVerification.js";
import { verifyDelegation } from "./delegation.js";
import { resolveMint } from "./mintDecimals.js";

/**
 * Settle a payment the relayer builds itself.
 *
 * This is the answer to to-be-fixed.md C2. The user is offline when they
 * consent, so what they sign is an *intent* — amount, asset, recipient, fees —
 * never a transaction. A transaction signed at intent time is dead on arrival:
 * its blockhash expires in ~60–90 seconds and the signature covers
 * `recentBlockhash`, so it cannot be refreshed without the user's key. The
 * durable artifact is therefore the inert intent, and the transaction is built
 * here, at settlement, against a fresh blockhash.
 *
 * ## The trust inversion, and the four gates that answer it
 *
 * Everywhere else the user's signature covers the instruction bytes. Here it
 * does not — the relayer produces bytes the user has never seen. Nothing
 * external stops a bug or a compromise from moving the wrong amount to the
 * wrong account, so the checks have to be internal and they have to run in this
 * order:
 *
 *   1. **Delegation** — the chain says we may move these tokens, and for at
 *      least this much. Read from the token account, never from the envelope:
 *      `metadata.hw` is *not* covered by the user's signature (validate.ts
 *      hashes only `s,r,a,f,t,n,ts`), so it is attacker-controlled data.
 *   2. **Construct** — build from the signed terms and nothing else.
 *   3. **Verify** — re-derive every destination independently and reconcile the
 *      transfer set against the intent. This is the gate that makes construction
 *      safe; it must pass *before* anything signs.
 *   4. **Sign** — delegate first (authorises the movement), fee payer second
 *      (pays for it).
 *
 * A failure at 1, 2, or 3 means nothing was signed and nothing can be
 * broadcast. That ordering is the whole security argument: an unsigned wrong
 * transaction is an error, a signed one is a liability that anyone holding the
 * bytes can submit.
 */

/** Everything the signed intent says about where value goes. */
export interface SettlementTerms {
  /** Sender's wallet address — the account being debited. */
  sender: string;
  /** Recipient's wallet address. The token account is derived, never supplied. */
  recipient: string;
  /** Mint being moved. */
  mint: string;
  /** Payment amount in base units. */
  amount: bigint;
  /** Fees the user agreed to, settled in the same transaction. */
  fees?: FeeTransfer[];
}

export type ConstructedSettlement =
  | { ok: true; transaction: Buffer; ataCreations: number; totalDebit: bigint }
  | { ok: false; failure: RelayerFailure };

/**
 * Build, verify, and sign the transaction a signed intent describes.
 *
 * Returns broadcast-ready bytes, or a structured failure. Never throws for an
 * expected condition — the caller routes the failure to a job status, and an
 * exception would lose the distinction between "the user has not approved us"
 * and "the process crashed".
 *
 * @param delegate the key users approved via `delegateUSDCAuthority`. Must be
 *   loaded from `DELEGATE_SECRET_KEY`, not the fee payer: this key moves other
 *   people's tokens.
 * @param feePayer the key that pays the signature fee and any ATA rent.
 */
export async function constructAndSignSettlement(
  connection: Connection,
  terms: SettlementTerms,
  delegate: Keypair,
  feePayer: Keypair,
  log: Logger,
): Promise<ConstructedSettlement> {
  const fees = terms.fees ?? [];

  // The debit is the payment plus every fee. Computed once here and reused for
  // the delegation check, so the allowance is tested against what the
  // transaction actually moves rather than against the payment alone — a
  // delegation that covers the payment but not the fees would otherwise fail
  // partway through a multi-instruction transaction.
  const totalDebit = fees.reduce((sum, f) => sum + f.amount, terms.amount);

  let mint: PublicKey;
  let sender: PublicKey;
  try {
    mint = new PublicKey(terms.mint);
    sender = new PublicKey(terms.sender);
  } catch {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "INVALID_SETTLEMENT_ADDRESS",
        `Intent carries an unparseable sender or mint (sender '${terms.sender}', ` +
          `mint '${terms.mint}').`,
      ),
    };
  }

  // ── Mint: decimals and owning program ──
  //
  // Both are required before anything can be built. `decimals` is an operand of
  // TransferChecked, and the token program is a seed of every ATA derivation —
  // a Token-2022 mint addressed under the classic program derives different
  // accounts entirely.
  let mintInfo;
  try {
    mintInfo = await resolveMint(connection, mint);
  } catch (e) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "MINT_UNRESOLVED",
        `Could not resolve mint ${terms.mint}: ${e instanceof Error ? e.message : String(e)}. ` +
          "Constructing a transfer with guessed decimals would move the wrong amount by a " +
          "power of ten, so this refuses instead.",
      ),
    };
  }

  // ── Gate 1: the chain must say we are the delegate ──
  const delegation = await verifyDelegation(connection, {
    sender,
    mint,
    delegate: delegate.publicKey,
    amount: totalDebit,
    tokenProgramId: mintInfo.programId,
  });
  if (!delegation.ok) return { ok: false, failure: delegation.failure };

  // ── Blockhash ──
  //
  // Fetched here, as late as possible before signing, because its ~60–90 second
  // life starts now. Anything slow between this call and broadcast eats into
  // that window.
  let recentBlockhash: string;
  try {
    ({ blockhash: recentBlockhash } = await connection.getLatestBlockhash("confirmed"));
  } catch (e) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.BlockhashExpired,
        "BLOCKHASH_FETCH_FAILED",
        `Could not fetch a recent blockhash: ${e instanceof Error ? e.message : String(e)}`,
        // Retriable, unlike every other failure here: the RPC being briefly
        // unreachable says nothing about the intent's validity.
        true,
      ),
    };
  }

  // ── Gate 2: construct from the signed terms ──
  let built;
  try {
    built = buildDelegatedTransfer({
      sender: terms.sender,
      recipient: terms.recipient,
      mint: terms.mint,
      amount: terms.amount,
      fees,
      decimals: mintInfo.decimals,
      feePayer: feePayer.publicKey,
      delegate: delegate.publicKey,
      recentBlockhash,
      tokenProgramId: mintInfo.programId,
    });
  } catch (e) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "CONSTRUCTION_FAILED",
        `Could not build the transfer: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }

  // ── Gate 3: verify before signing (HARD GATE) ──
  //
  // The check re-derives every destination from raw PDA seeds rather than
  // reusing the helper construction used, so a bug in that helper cannot pass
  // its own verification. It reconciles the transfer set both ways: an extra
  // transfer moves value the user never agreed to, and a *dropped* fee settles
  // the payment while a party the user agreed to pay goes unpaid.
  try {
    verifyConstructedTransaction(
      {
        amount: terms.amount,
        asset: terms.mint,
        recipient: terms.recipient,
        fees: fees.map((f) => ({ destination: f.destination, amount: f.amount })),
      },
      built.serialized,
    );
  } catch (e) {
    if (e instanceof ConstructedTransactionMismatchError) {
      // Logged at error, not warn: this means the relayer built something other
      // than what the user signed. Either a construction bug or tampering, and
      // both warrant a human looking.
      log.error(
        { detail: e.message, sender: terms.sender, recipient: terms.recipient },
        "Constructed transaction did not match the signed intent — NOT signed",
      );
      return { ok: false, failure: e.failure };
    }
    throw e;
  }

  // ── Gate 4: sign ──
  //
  // Only now, with every gate passed. `sign()` places each signature at its own
  // signer index; appending would produce more signatures than the message
  // declares signers, which serializes fine and then fails to deserialize.
  const tx = VersionedTransaction.deserialize(built.serialized);
  try {
    tx.sign([feePayer, delegate]);
  } catch (e) {
    // Reached when a required signer is missing from the message — a
    // construction defect rather than anything the user did.
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "SETTLEMENT_SIGN_FAILED",
        `Could not sign the constructed transfer: ${e instanceof Error ? e.message : String(e)}`,
      ),
    };
  }

  log.info(
    {
      sender: terms.sender,
      recipient: terms.recipient,
      mint: terms.mint,
      amount: terms.amount.toString(),
      feeCount: fees.length,
      totalDebit: totalDebit.toString(),
      ataCreations: built.ataCreationCount,
    },
    "Constructed, verified, and signed a delegated transfer",
  );

  return {
    ok: true,
    transaction: Buffer.from(tx.serialize()),
    ataCreations: built.ataCreationCount,
    totalDebit,
  };
}

/**
 * Load the delegate keypair, or explain precisely why settlement cannot run.
 *
 * Separate from `loadFeePayerKeypairs` because the two keys have different
 * blast radii and must not be interchangeable by accident: the fee payer spends
 * the relayer's own SOL, this one moves users' tokens.
 *
 * @throws {Error} if the key is absent or unparseable. Fatal by design —
 * proceeding without it would mean falling back to some other key, and the only
 * other key available is the fee payer.
 */
export function loadDelegateKeypair(config: Config): Keypair {
  const raw = config.DELEGATE_SECRET_KEY?.trim();
  if (!raw) {
    throw new Error(
      "DELEGATE_SECRET_KEY is not set, so the relayer cannot construct transfers. " +
        "This is the key users approve via delegateUSDCAuthority; without it there is no " +
        "authority to move their tokens. It is deliberately not defaulted to " +
        "FEE_PAYER_SECRET_KEY — that would give the fee-paying key drain authority over " +
        "every delegated balance.",
    );
  }

  let bytes: unknown;
  try {
    bytes = JSON.parse(raw);
  } catch {
    throw new Error("DELEGATE_SECRET_KEY must be a JSON array of byte values");
  }
  if (!Array.isArray(bytes) || bytes.some((b) => typeof b !== "number")) {
    throw new Error("DELEGATE_SECRET_KEY must be a JSON array of byte values");
  }
  return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
}
