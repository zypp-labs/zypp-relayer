import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import { coSignAsFeePayerWithKeys, type IntentEnvelope } from "./feePayer.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * Binding the envelope's claimed signer to the transaction's real one.
 *
 * The intent envelope is client-supplied JSON. Step 2 of the co-sign sequence
 * used to *prefer* `signature.publicKey` from it over the transaction's own
 * signer list, on the reasoning that validateV1 had already checked the field —
 * but validateV1 only checks that it is present and well-formed, never that it
 * has anything to do with the transaction. Nothing asserted the two agreed.
 *
 * That alone could not forge a payment. Step 4 still verifies a real Ed25519
 * signature over the real message bytes, so an attacker who does not hold the
 * named key cannot get past it. What it corrupted was *attribution*:
 * routes.ts reads `intent_sender` from this same envelope field, and
 * `(sender, nonce)` is the replay namespace. The key named in the envelope, the
 * key the signature was checked against, and the account whose tokens move were
 * free to be three different accounts — in the audit trail and in the replay
 * guard alike.
 *
 * These tests pin the gate that closes it: the envelope may say which of the
 * transaction's signers authored the intent; it may not introduce one the
 * transaction never asked to sign.
 */

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const FEE_PAYER = Keypair.fromSeed(
  Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1)),
);
/** The account that actually signs, and whose tokens actually move. */
const USER = Keypair.fromSeed(new Uint8Array(32).fill(42));
/** A real, valid public key that has nothing to do with the transaction. */
const OUTSIDER = Keypair.fromSeed(new Uint8Array(32).fill(77));

/**
 * A transaction naming FEE_PAYER as payer and USER as a signer, carrying a
 * genuine USER signature.
 *
 * The signature has to be real: step 4 rejects with USER_SIG_INVALID before any
 * of the properties here can be observed, so a placeholder would send every
 * test down the wrong branch and prove nothing.
 */
function signedTx(): Buffer {
  const source = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const destination = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;

  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK",
    instructions: [
      new TransactionInstruction({
        programId: TOKEN_PROGRAM_ID,
        keys: [
          { pubkey: source, isSigner: false, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: USER.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([3, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]),
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  // Signature `i` belongs to signer `i`. USER is signer 1 (the fee payer takes
  // 0), so this leaves slot 0 empty for the relayer — a correctly formed
  // partially-signed transaction.
  tx.addSignature(
    USER.publicKey,
    nacl.sign.detached(tx.message.serialize(), USER.secretKey),
  );
  return Buffer.from(tx.serialize());
}

function envelope(signerBase58?: string): IntentEnvelope {
  return {
    version: 1,
    network: "solana",
    intent: "payment",
    payload: {},
    ...(signerBase58
      ? { signature: { publicKey: signerBase58, signature: "unused-here", nonce: 1 } }
      : {}),
  };
}

// ─── the gate ───

test("co-signs when the envelope names a signer the transaction actually has", () => {
  // The baseline the refusals below are measured against. If this ever fails,
  // the gate has been drawn too tightly and every honest client is refused.
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(USER.publicKey.toBase58()),
    [FEE_PAYER],
  );
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

test("REFUSES an envelope naming a key the transaction never asked to sign", () => {
  // The regression. OUTSIDER is a perfectly valid public key; it is simply not
  // in this transaction. Before the gate, this was the value that reached
  // `intent_sender` and the (sender, nonce) replay namespace.
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(OUTSIDER.publicKey.toBase58()),
    [FEE_PAYER],
  );

  assert.equal(result.ok, false, "An unrelated account must not be accepted as the author.");
  if (result.ok) return;
  assert.equal(result.failure.code, "ENVELOPE_SIGNER_MISMATCH");
  assert.equal(result.failure.stage, RelayerFailureStage.Validation);
});

test("the refusal names the claim and the signers it was checked against", () => {
  // Both keys are public, and without them the operator cannot tell a
  // misconfigured client from an attempted substitution.
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(OUTSIDER.publicKey.toBase58()),
    [FEE_PAYER],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.failure.message, new RegExp(OUTSIDER.publicKey.toBase58()));
  assert.match(result.failure.message, new RegExp(USER.publicKey.toBase58()));
  assert.match(result.failure.message, /NOT co-signed/);
});

test("a non-signer account in the transaction is still not an acceptable author", () => {
  // The destination is present in staticAccountKeys but is not among the
  // required signers. A check written against the whole key list rather than
  // the signer prefix would wave this through — and it authorised nothing.
  const destination = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(destination.toBase58()),
    [FEE_PAYER],
  );
  assert.equal(result.ok, false, "Being referenced by the transaction is not authorship.");
  if (result.ok) return;
  assert.equal(result.failure.code, "ENVELOPE_SIGNER_MISMATCH");
});

test("naming the fee payer as the author reads the relayer's own empty slot", () => {
  // The fee payer IS a required signer, so the binding gate lets this through —
  // and it must, since that gate is about membership, not identity. The refusal
  // comes from the slot instead: signer 0 is the relayer, and the relayer has
  // not signed yet, so its slot is zero-filled. Two independent gates, and the
  // second is what makes a mislabelled author unexploitable rather than merely
  // unusual.
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(FEE_PAYER.publicKey.toBase58()),
    [FEE_PAYER],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "UNSET_SIGNATURE");
  assert.equal(result.failure.stage, RelayerFailureStage.SignatureCheck);
});

test("an unparseable publicKey is rejected, not ignored", () => {
  // Falling back to the transaction's signer list on a malformed claim would
  // make a corrupt envelope succeed quietly under a different author than it
  // named — the same attribution problem arriving by another route.
  const result = coSignAsFeePayerWithKeys(signedTx(), envelope("not-a-public-key"), [
    FEE_PAYER,
  ]);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_USER_PUBKEY");
});

test("with no signature block at all, the first non-fee-payer signer is used", () => {
  // Non-payment intents reach here without a signature block (validateV1 only
  // requires one for payments), so the fallback has to keep working.
  const result = coSignAsFeePayerWithKeys(signedTx(), envelope(), [FEE_PAYER]);
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

// ─── the co-signed transaction has to be readable ───

test("the co-signed transaction deserializes, with both signatures in their slots", () => {
  // REGRESSION, and the one that mattered most: step 8 used to `push` the
  // relayer's signature onto the array instead of writing it at the fee payer's
  // index. `serialize()` accepts that happily, so the function returned
  // ok:true — but the bytes carried one signature more than the message
  // declares signers, and `deserialize` runs them back through a constructor
  // that asserts the two are equal. Every co-signed transaction was
  // unreadable, and the runtime would have rejected it for the same reason.
  const result = coSignAsFeePayerWithKeys(
    signedTx(),
    envelope(USER.publicKey.toBase58()),
    [FEE_PAYER],
  );
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
  if (!result.ok) return;

  const back = VersionedTransaction.deserialize(result.tx);
  const messageBytes = back.message.serialize();

  assert.equal(
    back.signatures.length,
    back.message.header.numRequiredSignatures,
    "Signature count must equal the declared signer count.",
  );

  // Positional: signature i must verify under signer i, or the runtime rejects it.
  back.message.staticAccountKeys
    .slice(0, back.message.header.numRequiredSignatures)
    .forEach((signer, i) => {
      assert.ok(
        nacl.sign.detached.verify(messageBytes, back.signatures[i], signer.toBytes()),
        `Signature at slot ${i} does not verify under ${signer.toBase58()}, the signer that slot belongs to.`,
      );
    });
});
