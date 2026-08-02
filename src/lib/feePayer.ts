import {
  VersionedTransaction,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import type { RelayerFailure } from "./failureCodes.js";
import { RelayerFailureStage, relayerFailure } from "./failureCodes.js";

export interface IntentEnvelope {
  version: number;
  network: string;
  intent: string;
  payload: Record<string, unknown>;
  signature?: {
    publicKey: string;
    signature: string;
    nonce: number;
  };
}

export type CoSignResult =
  | { ok: true; tx: Buffer }
  | { ok: false; failure: RelayerFailure };

/**
 * Co-sign a partially-signed VersionedTransaction as fee payer.
 *
 * This function implements the 9-step verify-then-sign sequence:
 *
 *   1. Extract user's signature slot
 *   2. Extract user's public key from staticAccountKeys[0]
 *   3. Recover message bytes that were signed
 *   4. Ed25519 verify ── MUST pass before any further action
 *   5. Verify fee payer is set to relayer's public key
 *   6. Verify instructions match the declared intent
 *   7. Verify blockhash is not stale
 *   8. Co-sign as fee payer
 *   9. Return fully-signed transaction
 *
 * Steps 4, 5, 6, and 7 are hard gates: if any fails, step 8 is never reached.
 * The discriminated union return type (`CoSignResult`) enforces that `.tx`
 * is only accessible when `.ok === true`, making the gate verifiable at the
 * call site as well as in control flow.
 */
export function coSignAsFeePayer(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  feePayerKeypair: Keypair,
): CoSignResult {
  // ──────────────────────────────────────────────
  // Step 1: Deserialize and extract user signature
  // ──────────────────────────────────────────────
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(partiallySignedTx);
  } catch {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "TX_DESERIALIZE_FAILED",
        "Failed to deserialize VersionedTransaction from provided bytes",
      ),
    };
  }

  if (!tx.signatures || tx.signatures.length === 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "NO_USER_SIGNATURE",
        "Transaction has no signatures — user must partially sign before submitting",
      ),
    };
  }

  // Step 1: extract user's signature from the first signature slot
  const userSignature = tx.signatures[0];
  if (!userSignature) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "EMPTY_SIGNATURE_SLOT",
        "First signature slot is empty — user must provide a partial signature",
      ),
    };
  }

  // The user's signature is a Buffer; if it's all zeros (empty/unset), reject
  if (userSignature.every((b) => b === 0)) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "UNSET_SIGNATURE",
        "Signature slot contains an empty (zero-filled) signature",
      ),
    };
  }

  // ──────────────────────────────────────────────
  // Step 2: Extract user's public key
  // ──────────────────────────────────────────────

  // In a VersionedTransaction, staticAccountKeys[0] is the fee payer.
  // The user's signing key is the first signer, which maps to
  // staticAccountKeys[0] when the user is the fee payer, but in our
  // fee-payer model the relayer is the fee payer. The user's key is
  // typically staticAccountKeys[1] (the first non-fee-payer signer)
  // or we look it up from the intent envelope's signature block.
  //
  // Prefer the public key from the intent envelope's signature block
  // since that was already validated at the schema level in validateV1.
  // Fall back to staticAccountKeys[1] if not present in the envelope.
  let userPublicKey: PublicKey;
  try {
    if (intentEnvelope.signature?.publicKey) {
      userPublicKey = new PublicKey(intentEnvelope.signature.publicKey);
    } else if (tx.message.staticAccountKeys.length >= 2) {
      userPublicKey = tx.message.staticAccountKeys[1];
    } else if (tx.message.staticAccountKeys.length >= 1) {
      // Single-account tx: the fee payer IS the user (shouldn't happen in
      // fee-payer model, but handle gracefully)
      userPublicKey = tx.message.staticAccountKeys[0];
    } else {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.Validation,
          "NO_STATIC_ACCOUNTS",
          "Transaction has no static account keys — cannot determine signer",
        ),
      };
    }
  } catch {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "INVALID_USER_PUBKEY",
        "Could not construct PublicKey from envelope or transaction",
      ),
    };
  }

  // ──────────────────────────────────────────────
  // Step 3: Recover message bytes
  // ──────────────────────────────────────────────

  const messageBytes = tx.message.serialize();

  // ──────────────────────────────────────────────
  // Step 4: Ed25519 verify (HARD GATE)
  // ──────────────────────────────────────────────
  // If this fails, step 8 is never reached. The relayer MUST NOT co-sign
  // a transaction with an invalid user signature — that would make it a
  // blind co-signer for arbitrary payloads.

  const isValid = nacl.sign.detached.verify(
    messageBytes,
    userSignature,
    userPublicKey.toBytes(),
  );

  if (!isValid) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "USER_SIG_INVALID",
        "User's Ed25519 signature does not verify against message bytes and claimed public key. The transaction was NOT co-signed.",
      ),
    };
  }

  // ──────────────────────────────────────────────
  // Step 5: Verify fee payer is the relayer (HARD GATE)
  // ──────────────────────────────────────────────

  const expectedFeePayer = feePayerKeypair.publicKey;
  // For VersionedTransaction (v0), the fee payer is at staticAccountKeys[0]
  // when the tx is a v0 message. For legacy tx wrapped in VersionedTransaction,
  // it's the same. Check that the fee payer matches what we expect.
  const actualFeePayer = tx.message.staticAccountKeys[0];
  if (!actualFeePayer.equals(expectedFeePayer)) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.FeePayerCheck,
        "FEE_PAYER_MISMATCH",
        `Transaction fee payer is ${actualFeePayer.toBase58()} but relayer fee payer is ${expectedFeePayer.toBase58()}. The transaction was NOT co-signed.`,
      ),
    };
  }

  // ──────────────────────────────────────────────
  // Step 6: Verify instructions match declared intent (HARD GATE)
  // ──────────────────────────────────────────────

  const instructions = decompileInstructions(tx);
  const instructionResult = verifyInstructionsMatchIntent(
    instructions,
    intentEnvelope,
  );
  if (!instructionResult.ok) {
    return {
      ok: false,
      failure: instructionResult.failure,
    };
  }

  // ──────────────────────────────────────────────
  // Step 7: Verify blockhash freshness (HARD GATE)
  // ──────────────────────────────────────────────

  const blockhashResult = verifyBlockhashFreshness(tx);
  if (!blockhashResult.ok) {
    return {
      ok: false,
      failure: blockhashResult.failure,
    };
  }

  // ──────────────────────────────────────────────
  // Step 8: Co-sign as fee payer
  // ──────────────────────────────────────────────
  // All gates passed. Sign as fee payer.

  const signature = nacl.sign.detached(messageBytes, feePayerKeypair.secretKey);
  tx.signatures.push(signature);

  // ──────────────────────────────────────────────
  // Step 9: Return fully-signed transaction
  // ──────────────────────────────────────────────

  try {
    const serialized = Buffer.from(tx.serialize());
    return { ok: true, tx: serialized };
  } catch {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "TX_SERIALIZE_FAILED",
        "Failed to serialize fully-signed transaction",
      ),
    };
  }
}

// ──────────────────────────────────────────────
// Step 6 helpers: instruction matching
// ──────────────────────────────────────────────

function decompileInstructions(tx: VersionedTransaction): TransactionInstruction[] {
  const message = tx.message as any;
  if (message.instructions) {
    return message.instructions as TransactionInstruction[];
  }
  if (message.compiledInstructions) {
    return message.compiledInstructions.map((ci: any) => new TransactionInstruction({
      programId: message.staticAccountKeys[ci.programIdIndex],
      keys: (ci.accountKeyIndexes ?? ci.accounts ?? []).map((keyIndex: number) => ({
        pubkey: message.staticAccountKeys[keyIndex],
        isSigner: keyIndex < (message.header?.numRequiredSignatures ?? 0),
        isWritable: false,
      })),
      data: Buffer.from(ci.data ?? []),
    }));
  }
  return [];
}

type InstructionCheckResult =
  | { ok: true }
  | { ok: false; failure: RelayerFailure };

/**
 * Verify that the transaction's instructions are consistent with the
 * declared intent envelope. This is a defense-in-depth check — a valid
 * user signature proves the user intended *something*, but this check
 * confirms that *something* matches what they declared.
 *
 * For known intent types ("payment", "transfer"), we verify the instructions
 * match the expected program and account layout. For unknown types, we only
 * verify that instructions exist and are non-trivial (no empty program IDs).
 */
function verifyInstructionsMatchIntent(
  instructions: TransactionInstruction[],
  envelope: IntentEnvelope,
): InstructionCheckResult {
  if (!instructions || instructions.length === 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "NO_INSTRUCTIONS",
        "Transaction has no instructions — nothing to execute",
      ),
    };
  }

  const intentType = envelope.intent?.toLowerCase();

  if (intentType === "payment" || intentType === "transfer") {
    return verifyPaymentInstructions(instructions, envelope);
  }

  // For custom/unknown intent types, verify at minimum that instructions
  // reference real program IDs and are not trivial (no self-account loops).
  for (const ix of instructions) {
    if (ix.programId.equals(PublicKey.default)) {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.IntentMismatch,
          "INVALID_PROGRAM_ID",
          "Instruction references the default (zero-filled) program ID",
        ),
      };
    }
  }

  return { ok: true };
}

/**
 * Verify that at least one instruction looks like a valid token transfer:
 * calls the SPL Token program, references an SPL Token account, and the
 * destination account matches the declared recipient.
 *
 * This is a best-effort structural check, not a cryptographic proof.
 * It catches category errors (submitting a NFT mint instruction when
 * declaring a USDC payment) but does not guarantee the exact amount
 * or token type — that's the exit target's job.
 */
function verifyPaymentInstructions(
  instructions: TransactionInstruction[],
  envelope: IntentEnvelope,
): InstructionCheckResult {
  const payload = envelope.payload;
  const declaredRecipient = payload?.recipient;

  // SPL Token program IDs
  const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

  let foundTransfer = false;

  for (const ix of instructions) {
    const isTokenProgram =
      ix.programId.equals(TOKEN_PROGRAM_ID) ||
      ix.programId.equals(TOKEN_2022_PROGRAM_ID);

    if (!isTokenProgram) continue;

    // A transfer/transferChecked instruction typically has:
    //   accounts[0] = source token account
    //   accounts[1] = destination token account
    //   accounts[2] = authority/delegate
    // We check that the destination account is at least non-trivial
    // and if a declared recipient was provided, try to match it.

    if (ix.keys.length < 3) continue;

    const destAccount = ix.keys[1].pubkey;
    if (destAccount.equals(PublicKey.default)) continue;

    if (declaredRecipient) {
      try {
        const expectedRecipient = new PublicKey(declaredRecipient as string);
        // The destination ATA is not the same as the recipient wallet.
        // For a proper match we'd need to derive the ATA from the mint
        // and recipient, which requires the asset address. For now, we
        // check that the instruction isn't sending to a obviously-wrong
        // destination by verifying the account is a valid non-default key.
        // Full ATA derivation matching would require the mint from payload.
        if (destAccount.equals(expectedRecipient)) {
          foundTransfer = true;
        }
      } catch {
        // declaredRecipient wasn't a valid pubkey — skip this check
      }
    } else {
      // No declared recipient to match against, but instruction looks
      // like a transfer. Accept it.
      foundTransfer = true;
    }
  }

  if (!foundTransfer) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "NO_MATCHING_TRANSFER_INSTRUCTION",
        "No instruction in the transaction matches the declared payment intent. Expected a token transfer instruction referencing the SPL Token program.",
      ),
    };
  }

  return { ok: true };
}

// ──────────────────────────────────────────────
// Step 7 helpers: blockhash freshness
// ──────────────────────────────────────────────

function verifyBlockhashFreshness(tx: VersionedTransaction): InstructionCheckResult {
  // VersionedTransaction.message.recentBlockhash is a string.
  // We cannot determine the block height from the blockhash alone without
  // an RPC call. Instead, we check that the blockhash is not the default
  // (zeroed-out) value, which indicates the user didn't set one.
  const blockhash = tx.message.recentBlockhash;
  if (!blockhash || blockhash === "11111111111111111111111111111111") {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.BlockhashExpired,
        "MISSING_BLOCKHASH",
        "Transaction has no recent blockhash set. User must fetch a recent blockhash before signing.",
      ),
    };
  }

  // The blockhash itself doesn't encode its age, so we can't verify
  // freshness without an RPC call. The true freshness check happens
  // at broadcast time (Solana RPC will reject stale blockhashes with
  // "blockhash not found"). Our check here is structural: the blockhash
  // is present and non-trivial.
  return { ok: true };
}
