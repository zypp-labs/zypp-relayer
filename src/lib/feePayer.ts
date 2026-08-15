import {
  VersionedTransaction,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import type { RelayerFailure } from "./failureCodes.js";
import { RelayerFailureStage, relayerFailure } from "./failureCodes.js";

/** Canonical SPL Token program. */
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022. Accepted, but a mint lives under exactly one of the two. */
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
/** Associated Token Account program — the PDA owner for every derived address. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** SPL Token instruction discriminator for TransferChecked. */
const IX_TRANSFER_CHECKED = 12;

/**
 * Derive the associated token account for (owner, mint).
 *
 * Hand-rolled rather than imported from @solana/spl-token, matching
 * `outboundVerification.ts`: this is a verification path, and it must not share
 * a derivation with any code that *builds* transactions. If both used one
 * helper, a bug in that helper would produce a wrong destination and then
 * confirm it as correct.
 *
 * PDA derivation is a specified, stable algorithm — seeds are
 * [owner, tokenProgram, mint] under the ATA program.
 */
function associatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return address;
}

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
  /** `feePayer` is the base58 key that actually signed — needed to observe rotation. */
  | { ok: true; tx: Buffer; feePayer: string }
  | { ok: false; failure: RelayerFailure };

/** The fee-payer keys this relayer will co-sign with. */
export interface LoadedFeePayerKeys {
  /** Every accepted key: the current one first, then any draining legacy keys. */
  keypairs: Keypair[];
  /** The current key — the one clients should be naming in new transactions. */
  primary: Keypair;
}

/**
 * Load the accepted fee-payer key set from config.
 *
 * `FEE_PAYER_SECRET_KEY` is the current key. `FEE_PAYER_LEGACY_SECRET_KEYS` is a
 * comma-separated list of keys being rotated out — still honoured for in-flight
 * transactions that already name them, never advertised for new ones.
 *
 * Rotation needs this because a client bakes the fee payer's *public* key into
 * the message it signs. Swapping a single key instantly invalidates every
 * already-signed transaction naming the old one, and with a 120-day intent TTL
 * that window is enormous. Accepting a set turns rotation into a drain rather
 * than a cutover.
 *
 * @throws {Error} if any configured key fails to parse — callers must treat this
 * as fatal rather than proceeding with a partial key set, since a missing legacy
 * key silently strands exactly the transactions it was meant to rescue.
 */
export function loadFeePayerKeypairs(config: {
  FEE_PAYER_SECRET_KEY: string;
  FEE_PAYER_LEGACY_SECRET_KEYS?: string;
}): LoadedFeePayerKeys {
  const fromBytes = (bytes: unknown, label: string): Keypair => {
    if (!Array.isArray(bytes) || bytes.some((b) => typeof b !== "number")) {
      throw new Error(`${label} must be a JSON array of byte values`);
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  };

  const primary = fromBytes(
    JSON.parse(config.FEE_PAYER_SECRET_KEY),
    "FEE_PAYER_SECRET_KEY",
  );
  const keypairs: Keypair[] = [primary];

  const rawLegacy = (config.FEE_PAYER_LEGACY_SECRET_KEYS ?? "").trim();
  if (rawLegacy) {
    const parsed = JSON.parse(rawLegacy);
    if (!Array.isArray(parsed)) {
      throw new Error("FEE_PAYER_LEGACY_SECRET_KEYS must be a JSON array");
    }

    // Accepts either shape, because during a rotation there is almost always
    // exactly one legacy key and `cat keyfile.json` is what an operator will
    // reach for:
    //   one key   → a flat array of bytes,  [1,2,3,...]
    //   several   → an array of those,     [[1,2,...],[3,4,...]]
    // Discriminating on the first element is unambiguous: a byte is a number,
    // a key is an array. NOT comma-splitting the string — a JSON byte array
    // contains commas, so splitting on them shreds the key.
    if (parsed.length > 0) {
      const entries: unknown[] = Array.isArray(parsed[0]) ? parsed : [parsed];
      for (const entry of entries) {
        const legacy = fromBytes(entry, "FEE_PAYER_LEGACY_SECRET_KEYS entry");
        // A legacy entry duplicating the primary is harmless but would make the
        // "accepted keys" diagnostics misleading during a rotation.
        if (!keypairs.some((k) => k.publicKey.equals(legacy.publicKey))) {
          keypairs.push(legacy);
        }
      }
    }
  }

  return { keypairs, primary };
}

/**
 * Co-sign as a single fee payer.
 *
 * Kept for callers with exactly one key. Production paths should use
 * `coSignAsFeePayerWithKeys` so a rotation does not strand in-flight work.
 */
export function coSignAsFeePayer(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  feePayerKeypair: Keypair,
): CoSignResult {
  return coSignAsFeePayerWithKeys(partiallySignedTx, intentEnvelope, [feePayerKeypair]);
}

/**
 * Co-sign a partially-signed VersionedTransaction as whichever accepted fee
 * payer the transaction names.
 *
 * This function implements the 9-step verify-then-sign sequence:
 *
 *   1. Extract user's signature slot
 *   2. Identify the user's key, binding any envelope claim to a real signer
 *   3. Recover message bytes that were signed
 *   4. Ed25519 verify ── MUST pass before any further action
 *   5. Verify the named fee payer is one we hold, and select that key
 *   6. Verify instructions match the declared intent
 *   7. Verify blockhash is not stale
 *   8. Co-sign with the selected key
 *   9. Return fully-signed transaction
 *
 * Steps 2, 4, 5, 6, and 7 are hard gates: if any fails, step 8 is never reached.
 * The discriminated union return type (`CoSignResult`) enforces that `.tx`
 * is only accessible when `.ok === true`, making the gate verifiable at the
 * call site as well as in control flow.
 *
 * Step 5 accepting a *set* is what makes rotation survivable — see
 * `loadFeePayerKeypairs`.
 */
export function coSignAsFeePayerWithKeys(
  partiallySignedTx: Buffer,
  intentEnvelope: IntentEnvelope,
  feePayerKeypairs: Keypair[],
): CoSignResult {
  // ──────────────────────────────────────────────
  // Step 1: Deserialize
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

  // ──────────────────────────────────────────────
  // Step 2: Identify the user's public key (HARD GATE)
  // ──────────────────────────────────────────────

  // Only the first `numRequiredSignatures` static keys are signers. Everything
  // after them is an account the transaction merely references, and never
  // authorised anything — so the search below is over that prefix, not over the
  // whole key list.
  //
  // In this fee-payer model staticAccountKeys[0] is the relayer and the user is
  // the next signer along, but that is a convention of the current client rather
  // than something the format guarantees, which is why the envelope is allowed to
  // name the signer explicitly.
  const signerKeys = tx.message.staticAccountKeys.slice(
    0,
    tx.message.header.numRequiredSignatures,
  );

  if (signerKeys.length === 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.Validation,
        "NO_STATIC_ACCOUNTS",
        "Transaction declares no required signers — cannot determine who authorised it",
      ),
    };
  }

  let userIndex: number;
  if (intentEnvelope.signature?.publicKey) {
    let claimed: PublicKey;
    try {
      claimed = new PublicKey(intentEnvelope.signature.publicKey);
    } catch {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.Validation,
          "INVALID_USER_PUBKEY",
          "Could not construct PublicKey from the envelope's signature.publicKey",
        ),
      };
    }

    // The envelope is client-supplied JSON, and the previous version of this
    // code simply believed it — it *preferred* the envelope's key over the
    // transaction's own signer list, with nothing asserting the two agreed.
    //
    // That could not forge a payment: step 4 still verifies a real Ed25519
    // signature over the real message bytes, and an attacker who does not hold
    // the named key cannot produce one. What it corrupted was attribution.
    // routes.ts reads `intent_sender` from this same envelope field, and
    // `(sender, nonce)` is the replay namespace — so the key named in the
    // envelope, the key the signature was verified against, and the account
    // whose tokens actually move were free to be three different accounts, in
    // the audit trail and in the replay guard alike.
    //
    // Binding the claim to the transaction closes that: the envelope may say
    // which signer authored the intent, but it may not introduce a signer the
    // transaction does not have.
    userIndex = signerKeys.findIndex((k) => k.equals(claimed));
    if (userIndex === -1) {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.Validation,
          "ENVELOPE_SIGNER_MISMATCH",
          `Intent envelope names ${claimed.toBase58()} as the signer, but the transaction's ` +
            `required signers are [${signerKeys.map((k) => k.toBase58()).join(", ")}]. ` +
            "The envelope may identify which of the transaction's signers authored the intent; " +
            "it may not name an account the transaction never asked to sign. " +
            "The transaction was NOT co-signed.",
        ),
      };
    }
  } else {
    // No claim to check. Fall back to the convention: the first signer that is
    // not the fee payer, or the sole signer when the transaction has only one
    // (which should not happen in this model, but is handled rather than thrown).
    userIndex = signerKeys.length >= 2 ? 1 : 0;
  }

  const userPublicKey = signerKeys[userIndex];

  // ──────────────────────────────────────────────
  // Step 2b: Take the signature from that signer's own slot
  // ──────────────────────────────────────────────
  // Signature `i` belongs to signer `i`. Both `VersionedTransaction.sign()` and
  // `.addSignature()` write at the signer's own index, and the runtime verifies
  // them positionally against the same list.
  //
  // This used to read `tx.signatures[0]` unconditionally — which in this model
  // is the *relayer's* slot, not the user's. A client that partially signs
  // correctly puts its signature at its own index and leaves slot 0 empty for
  // the fee payer, so reading slot 0 rejected every correctly-formed
  // transaction as UNSET_SIGNATURE and accepted only those that had misfiled
  // the user's signature into the relayer's slot.
  const userSignature = tx.signatures[userIndex];
  if (!userSignature) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "EMPTY_SIGNATURE_SLOT",
        `Transaction carries no signature slot for ${userPublicKey.toBase58()} ` +
          `(signer index ${userIndex}).`,
      ),
    };
  }

  if (userSignature.every((b) => b === 0)) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.SignatureCheck,
        "UNSET_SIGNATURE",
        `Signature slot for ${userPublicKey.toBase58()} (signer index ${userIndex}) is ` +
          "zero-filled — the user must partially sign before submitting.",
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
  // Step 5: Verify the named fee payer is one we hold (HARD GATE)
  // ──────────────────────────────────────────────
  // For VersionedTransaction (v0), the fee payer is at staticAccountKeys[0].
  // Rather than compare against a single key, select whichever accepted key the
  // transaction names. This is what lets a rotation drain: a transaction signed
  // days ago against the previous key still finds its match here, while new
  // transactions use the current one.

  if (feePayerKeypairs.length === 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.FeePayerCheck,
        "NO_FEE_PAYER_CONFIGURED",
        "No fee-payer keys are configured; cannot co-sign.",
      ),
    };
  }

  const actualFeePayer = tx.message.staticAccountKeys[0];
  const selectedKeypair = feePayerKeypairs.find((kp) =>
    actualFeePayer.equals(kp.publicKey),
  );

  if (!selectedKeypair) {
    const accepted = feePayerKeypairs.map((kp) => kp.publicKey.toBase58()).join(", ");
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.FeePayerCheck,
        "FEE_PAYER_MISMATCH",
        `Transaction fee payer is ${actualFeePayer.toBase58()} but this relayer holds ` +
          `[${accepted}]. The transaction was NOT co-signed. If this key was recently ` +
          "rotated out, add it to FEE_PAYER_LEGACY_SECRET_KEYS until in-flight work drains.",
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
  // All gates passed. Sign with the key the transaction actually named, which
  // during a rotation may be a legacy key rather than the current one.

  const signature = nacl.sign.detached(messageBytes, selectedKeypair.secretKey);

  // Placed at the fee payer's own index, not appended.
  //
  // `tx.signatures.push(...)` grew the array past `numRequiredSignatures`. Those
  // bytes serialize happily — `serialize()` writes however many it is handed —
  // but nothing can read them back: `VersionedTransaction.deserialize`
  // reconstructs through a constructor that asserts
  // `signatures.length === numRequiredSignatures`, and the runtime verifies
  // signatures positionally against the signer list. So the transaction this
  // function returned was malformed on the wire, with the relayer's signature
  // in a slot belonging to no signer and its own slot left as whatever the
  // client happened to send.
  //
  // Step 5 has already established that the transaction's fee payer is this
  // keypair, so the lookup cannot miss.
  const feePayerIndex = signerKeys.findIndex((k) =>
    k.equals(selectedKeypair.publicKey),
  );
  tx.signatures[feePayerIndex] = signature;

  // ──────────────────────────────────────────────
  // Step 9: Return fully-signed transaction
  // ──────────────────────────────────────────────

  try {
    const serialized = Buffer.from(tx.serialize());
    return { ok: true, tx: serialized, feePayer: selectedKeypair.publicKey.toBase58() };
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
 * Verify that a client-supplied transaction moves value only where the intent
 * says it should.
 *
 * ## What this used to do, and why it was not enough
 *
 * The original set `foundTransfer = true` on the first plausible transfer and
 * failed only if *nothing* matched. It never asserted how many transfers were
 * present, so a client could append a second transfer to its own wallet and the
 * relayer would co-sign it: the user's signature covers the whole message, but
 * the *user* never saw these bytes assembled — the client did. That is A1
 * weakness 1 in to-be-fixed.md.
 *
 * It also compared the instruction's destination against the declared recipient
 * *wallet*, when a transfer's destination is the recipient's associated token
 * account. Those are never equal, so with a recipient declared the check could
 * only ever fail, and with none declared it accepted any transfer at all.
 *
 * ## What it does now
 *
 * The same reconciliation the outbound guard performs, in the inbound
 * direction: every SPL transfer in the transaction must correspond to a
 * transfer the intent declares, and every declared transfer must be present.
 * Matching is a (destination, amount) bijection — the destination is derived
 * from the declared wallet, never compared as one, and the amount must equal
 * the declared amount, so a declared fee of 10,000 that moves 5,000,000 to the
 * same address is refused rather than waved through.
 *
 * ## The limit of what it can prove, stated plainly
 *
 * This can only check what the envelope carries. The envelope now carries the
 * signed terms (`asset`, `recipient`, `amount`, `fees`) whenever the native
 * queue exports them, so a terms-carrying envelope reconciles exactly. An
 * envelope without terms — a client built against an older SDK — degrades to
 * "exactly one transfer, and no unexpected programs", which refuses a smuggled
 * second transfer but cannot prove the single transfer matches what the user
 * agreed to.
 *
 * And even with terms, this is a *consistency* check: it proves the transaction
 * does not disagree with the intent, and the user's signature covers the
 * transaction. A client that lies in the payload, the transaction, and its own
 * signing consistently is not caught here — that is what the relayer-constructed
 * path (`settlement.ts`) is for, since it builds from the signed intent rather
 * than inspecting someone else's bytes.
 */
function verifyPaymentInstructions(
  instructions: TransactionInstruction[],
  envelope: IntentEnvelope,
): InstructionCheckResult {
  const transfers = instructions.filter(
    (ix) =>
      ix.programId.equals(TOKEN_PROGRAM_ID) || ix.programId.equals(TOKEN_2022_PROGRAM_ID),
  );

  if (transfers.length === 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "NO_MATCHING_TRANSFER_INSTRUCTION",
        "No instruction in the transaction references the SPL Token program, so the " +
          "transaction cannot be the payment it declares.",
      ),
    };
  }

  const payload = envelope.payload ?? {};
  const declaredRecipient = typeof payload.recipient === "string" ? payload.recipient : null;
  const declaredAsset = typeof payload.asset === "string" ? payload.asset : null;
  const declaredFees = Array.isArray(payload.fees) ? payload.fees : [];

  // The number of transfers the intent describes: the payment, plus one per
  // declared fee. Checked even when the destinations cannot be resolved,
  // because the *count* alone catches a smuggled extra transfer.
  const expectedCount = 1 + declaredFees.length;
  if (transfers.length !== expectedCount) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "TRANSFER_COUNT_MISMATCH",
        `The transaction contains ${transfers.length} SPL transfer(s) but the intent declares ` +
          `${expectedCount} (one payment${declaredFees.length ? ` plus ${declaredFees.length} fee(s)` : ""}). ` +
          "A transaction may express only the transfers the user agreed to.",
      ),
    };
  }

  // Without both a recipient and an asset the destination cannot be derived, so
  // the count check above is all that can be enforced. This is the thin-envelope
  // case described in the doc comment — not an oversight, and not sufficient.
  if (!declaredRecipient || !declaredAsset) {
    return { ok: true };
  }

  let mint: PublicKey;
  let recipient: PublicKey;
  try {
    mint = new PublicKey(declaredAsset);
    recipient = new PublicKey(declaredRecipient);
  } catch {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "INVALID_DECLARED_TERMS",
        `The intent declares asset '${declaredAsset}' and recipient '${declaredRecipient}', ` +
          "at least one of which is not a valid public key.",
      ),
    };
  }

  const tokenProgram = transfers[0].programId.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  // Every transfer the intent requires, as a (destination, amount) pair.
  // Destinations are *derived* rather than compared as wallets — a transfer
  // sends to an associated token account, never to the wallet itself.
  //
  // Amount is part of the pair, not a separate check. Matching on destination
  // alone would accept a declared fee of 10,000 that actually moved 5,000,000
  // to the same address: the destination is declared, so a set-of-addresses
  // check passes, and the extra value leaves with the payment.
  const expected: DeclaredTransfer[] = [];

  const declaredAmount = parseDeclaredAmount(payload.amount);
  if (declaredAmount === INVALID_AMOUNT) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "INVALID_DECLARED_TERMS",
        `The intent declares an amount of '${String(payload.amount)}', which is not a ` +
          "non-negative integer. Amounts must cross as decimal strings.",
      ),
    };
  }

  expected.push({
    label: "the payment",
    destination: associatedTokenAddress(recipient, mint, tokenProgram),
    amount: declaredAmount,
  });

  for (const [i, fee] of declaredFees.entries()) {
    const entry = fee as { destination?: unknown; amount?: unknown };
    const feeAmount = parseDeclaredAmount(entry?.amount);
    let feeDestination: PublicKey;
    try {
      if (typeof entry?.destination !== "string") throw new Error("not a string");
      feeDestination = new PublicKey(entry.destination);
    } catch {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.IntentMismatch,
          "INVALID_DECLARED_TERMS",
          `The intent declares fees[${i}].destination as '${String(entry?.destination)}', ` +
            "which is not a valid public key. A fee whose destination cannot be resolved " +
            "cannot be reconciled, and an unreconciled transfer is not co-signed.",
        ),
      };
    }
    if (feeAmount === INVALID_AMOUNT) {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.IntentMismatch,
          "INVALID_DECLARED_TERMS",
          `The intent declares fees[${i}].amount as '${String(entry?.amount)}', which is ` +
            "not a non-negative integer.",
        ),
      };
    }
    expected.push({
      label: `fees[${i}]`,
      destination: associatedTokenAddress(feeDestination, mint, tokenProgram),
      amount: feeAmount,
    });
  }

  // Parse the transaction's transfers into the same shape.
  const actual: { destination: PublicKey; amount: bigint | null }[] = [];
  for (const ix of transfers) {
    // Transfer: [source, destination, authority]
    // TransferChecked: [source, mint, destination, authority]
    const isChecked = ix.data.length > 0 && ix.data[0] === IX_TRANSFER_CHECKED;
    const destinationIndex = isChecked ? 2 : 1;

    if (ix.keys.length <= destinationIndex) {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.IntentMismatch,
          "MALFORMED_TRANSFER_INSTRUCTION",
          `A transfer instruction has ${ix.keys.length} accounts, too few to carry a destination.`,
        ),
      };
    }

    // `[discriminator: u8, amount: u64le, ...]` for both Transfer and
    // TransferChecked. Null when the data is too short to hold an amount, which
    // leaves the destination checkable but the amount not.
    const amount = ix.data.length >= 9 ? ix.data.readBigUInt64LE(1) : null;
    actual.push({ destination: ix.keys[destinationIndex].pubkey, amount });
  }

  // Greedy pairing, so duplicates are handled correctly: two declared fees of
  // equal amount to the same address require two matching instructions, because
  // each expected entry consumes exactly one.
  const unmatched = [...actual];
  for (const want of expected) {
    const at = unmatched.findIndex(
      (got) => got.destination.equals(want.destination) && got.amount === want.amount,
    );
    if (at !== -1) {
      unmatched.splice(at, 1);
      continue;
    }

    // Report the more specific diagnosis. A transfer to the right account for
    // the wrong amount is an altered term; no transfer to that account at all
    // is a redirected or dropped one.
    const sameDestination = unmatched.find((got) =>
      got.destination.equals(want.destination),
    );
    if (sameDestination) {
      return {
        ok: false,
        failure: relayerFailure(
          RelayerFailureStage.IntentMismatch,
          "TRANSFER_AMOUNT_MISMATCH",
          `${want.label} is declared as ${want.amount} but the transaction moves ` +
            `${sameDestination.amount === null ? "an unreadable amount" : sameDestination.amount} ` +
            `to ${want.destination.toBase58()}. The transaction was NOT co-signed.`,
        ),
      };
    }

    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "UNDECLARED_TRANSFER_DESTINATION",
        `${want.label} is declared as ${want.amount} to ${want.destination.toBase58()}, ` +
          "but no transfer in the transaction matches it. Value is going somewhere the " +
          "intent does not name. The transaction was NOT co-signed.",
      ),
    };
  }

  // The count check above already guarantees this is empty, but asserting it
  // rather than assuming it means the bijection holds on its own terms — if the
  // count check is ever relaxed, this does not silently become fail-open.
  if (unmatched.length > 0) {
    return {
      ok: false,
      failure: relayerFailure(
        RelayerFailureStage.IntentMismatch,
        "UNDECLARED_TRANSFER_DESTINATION",
        `The transaction contains ${unmatched.length} transfer(s) the intent does not ` +
          `describe: ${unmatched
            .map((u) => `${u.amount ?? "unreadable"} to ${u.destination.toBase58()}`)
            .join(", ")}. The transaction was NOT co-signed.`,
      ),
    };
  }

  return { ok: true };
}

/** One transfer the intent declares, with its destination account resolved. */
interface DeclaredTransfer {
  /** How this entry is named in an error: "the payment", or `fees[0]`. */
  label: string;
  /** The destination *token account*, derived from the declared wallet. */
  destination: PublicKey;
  amount: bigint;
}

/**
 * Sentinel for a declared amount that could not be read.
 *
 * A distinct value rather than null so `INVALID_AMOUNT` can never be mistaken
 * for a legitimate amount by a `== null` check, and never silently compares
 * equal to a transfer's amount — negative is unreachable for a u64 read.
 */
const INVALID_AMOUNT = -1n;

/**
 * Read a declared amount, which crosses the wire as a decimal string.
 *
 * Strings, not JSON numbers: every JS producer of this payload holds integers
 * exactly only below 2^53, so a large amount sent as a number arrives changed.
 * A number is still *accepted* here when it is a safe integer — the relayer must
 * not reject a client that has not yet been rebuilt against the string-emitting
 * SDK — but anything past that limit is refused rather than silently trusted,
 * because at that point the value has already lost precision upstream.
 *
 * Returns `INVALID_AMOUNT` for anything unreadable. An absent amount is 0, which
 * pairs only with a transfer that actually moves 0 — so a payload that omits the
 * amount cannot match a real transfer and is caught as a mismatch rather than
 * waved through.
 */
function parseDeclaredAmount(value: unknown): bigint {
  if (value === undefined || value === null) return 0n;

  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) return INVALID_AMOUNT;
    try {
      return BigInt(value);
    } catch {
      return INVALID_AMOUNT;
    }
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return INVALID_AMOUNT;
    return BigInt(value);
  }

  if (typeof value === "bigint") {
    return value < 0n ? INVALID_AMOUNT : value;
  }

  return INVALID_AMOUNT;
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
