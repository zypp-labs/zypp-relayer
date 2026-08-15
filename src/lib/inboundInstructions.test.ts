import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { coSignAsFeePayerWithKeys, type IntentEnvelope } from "./feePayer.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * The inbound instruction check — A1.
 *
 * On this path the *client* assembles the transaction and the relayer co-signs
 * it. The user's signature covers the whole message, but the user never saw
 * these bytes assembled: their app did. So a compromised or dishonest client
 * can put anything in the transaction and the signature will still verify.
 *
 * The original check set `foundTransfer = true` on the first plausible transfer
 * and failed only if *nothing* matched — so a second transfer, to the
 * developer's own wallet, was co-signed without complaint (weakness 1). It also
 * had nothing to reconcile against, because the queue exported no payload terms
 * (weakness 2). Both halves are closed: the envelope now carries the signed
 * terms, and this check pairs them against the transaction as a bijection.
 *
 * Two envelope shapes appear below, and both are real. A **terms-carrying**
 * envelope comes from an SDK built after the queue export landed and reconciles
 * exactly. A **thin** envelope comes from a client that has not been rebuilt;
 * it degrades to a count check, which still refuses a smuggled transfer but
 * cannot prove the one transfer present is the right one.
 */

const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(1));
const USER = Keypair.fromSeed(new Uint8Array(32).fill(42));
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey;
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(8)).publicKey;
/** The developer's own wallet — where a smuggled transfer would go. */
const ATTACKER = Keypair.fromSeed(new Uint8Array(32).fill(66)).publicKey;
const FEE_DEST = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;

/** The amount every declared payment in this file moves. */
const AMOUNT = 1_000_000n;
const FEE_AMOUNT = 10_000n;

const ata = (owner: PublicKey) =>
  getAssociatedTokenAddressSync(MINT, owner, false, TOKEN_PROGRAM_ID);

const transferTo = (destination: PublicKey, amount: bigint) =>
  createTransferCheckedInstruction(
    ata(USER.publicKey),
    MINT,
    destination,
    USER.publicKey,
    amount,
    6,
    [],
    TOKEN_PROGRAM_ID,
  );

/** A transaction carrying `instructions`, genuinely signed by the user. */
function signedTx(instructions: TransactionInstruction[]): Buffer {
  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK",
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.addSignature(
    USER.publicKey,
    nacl.sign.detached(tx.message.serialize(), USER.secretKey),
  );
  return Buffer.from(tx.serialize());
}

function envelope(payload: Record<string, unknown>): IntentEnvelope {
  return {
    version: 1,
    network: "solana",
    intent: "payment",
    payload,
    signature: {
      publicKey: USER.publicKey.toBase58(),
      signature: "checked-elsewhere",
      nonce: 1,
    },
  };
}

/**
 * Terms a full envelope declares, exactly as `zypp_get_queue` exports them.
 *
 * `amount` is a string because that is how it crosses: JSON numbers are IEEE-754
 * doubles in every JS producer, exact only below 2^53 — on a value that moves
 * money.
 */
const FULL = {
  asset: MINT.toBase58(),
  recipient: RECIPIENT.toBase58(),
  amount: AMOUNT.toString(),
};

/** A declared fee, in the exported shape. */
const fee = (destination: PublicKey, amount: bigint) => ({
  destination: destination.toBase58(),
  amount: amount.toString(),
});

const cosign = (tx: Buffer, env: IntentEnvelope) =>
  coSignAsFeePayerWithKeys(tx, env, [FEE_PAYER]);

/** The one shape a correct payment takes; several tests build on it. */
const correctPayment = () => signedTx([transferTo(ata(RECIPIENT), AMOUNT)]);

// ─── the attack this check exists to stop ───

test("REFUSES a second transfer smuggled alongside the declared payment", () => {
  // A1 weakness 1, exactly. The declared payment is present and correct; the
  // client has appended a transfer of its own to a wallet it controls. The old
  // check found the first transfer, set a flag, and co-signed.
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(ATTACKER), 5_000_000n),
  ]);

  const result = cosign(tx, envelope(FULL));

  assert.equal(result.ok, false, "a smuggled transfer must not be co-signed");
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_COUNT_MISMATCH");
  assert.equal(result.failure.stage, RelayerFailureStage.IntentMismatch);
});

test("REFUSES a payment redirected to an undeclared destination", () => {
  // One transfer, so the count matches — but it goes somewhere the intent never
  // named. Caught by destination derivation rather than by counting.
  const tx = signedTx([transferTo(ata(ATTACKER), AMOUNT)]);

  const result = cosign(tx, envelope(FULL));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "UNDECLARED_TRANSFER_DESTINATION");
  assert.match(result.failure.message, /NOT co-signed/);
});

test("REFUSES a payment inflated beyond its declared amount", () => {
  // The right recipient, the right count — a wrong number. Matching on
  // destination alone accepted this: the address is declared, so a
  // set-of-addresses check passes and the extra value leaves with the payment.
  const tx = signedTx([transferTo(ata(RECIPIENT), AMOUNT * 100n)]);

  const result = cosign(tx, envelope(FULL));

  assert.equal(result.ok, false, "an inflated amount must not be co-signed");
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_AMOUNT_MISMATCH");
  assert.match(result.failure.message, /100000000/);
});

test("REFUSES a fee inflated beyond its declared amount", () => {
  // The same attack aimed at the fee, which is the more attractive target: a
  // fee is expected to be small and to go to the developer, so an inflated one
  // looks less anomalous than an inflated payment.
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(FEE_DEST), 5_000_000n),
  ]);

  const result = cosign(tx, envelope({ ...FULL, fees: [fee(FEE_DEST, FEE_AMOUNT)] }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_AMOUNT_MISMATCH");
  assert.match(result.failure.message, /fees\[0\]/);
});

test("the destination is derived, not compared against the wallet", () => {
  // REGRESSION. The original compared the instruction's destination to the
  // declared recipient *wallet* — but a transfer sends to the recipient's
  // associated token account, which is never equal to the wallet. So with a
  // recipient declared the check could only ever fail. A correct payment has to
  // pass, or the check is just an outage.
  const result = cosign(correctPayment(), envelope(FULL));

  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

// ─── declared fees ───

test("a declared fee is accepted alongside the payment", () => {
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
  ]);

  const result = cosign(tx, envelope({ ...FULL, fees: [fee(FEE_DEST, FEE_AMOUNT)] }));

  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

test("REFUSES a declared fee that was dropped from the transaction", () => {
  // The other direction. A client that declares a fee and then omits it is
  // settling different terms than the user agreed to.
  const result = cosign(
    correctPayment(),
    envelope({ ...FULL, fees: [fee(FEE_DEST, FEE_AMOUNT)] }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_COUNT_MISMATCH");
});

test("REFUSES a fee redirected away from its declared destination", () => {
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(ATTACKER), FEE_AMOUNT),
  ]);

  const result = cosign(tx, envelope({ ...FULL, fees: [fee(FEE_DEST, FEE_AMOUNT)] }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "UNDECLARED_TRANSFER_DESTINATION");
});

test("two identical fees require two matching transfers, not one", () => {
  // Duplicates are why matching consumes an instruction per expected entry
  // rather than checking membership in a set. Under a set check this passes
  // with one transfer present and one fee silently unpaid.
  const declared = envelope({
    ...FULL,
    fees: [fee(FEE_DEST, FEE_AMOUNT), fee(FEE_DEST, FEE_AMOUNT)],
  });

  const both = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
  ]);
  assert.equal(cosign(both, declared).ok, true, "two declared, two present, must pass");

  const onlyOne = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
  ]);
  const result = cosign(onlyOne, declared);
  assert.equal(result.ok, false, "the second fee is unpaid and must be caught");
});

test("fees need not appear in declared order", () => {
  // Reconciliation is set-based; order affects only how an error names an
  // entry. A client that emits its fee before the payment is unusual but not
  // dishonest, and refusing it would be an outage rather than a protection.
  const tx = signedTx([
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
    transferTo(ata(RECIPIENT), AMOUNT),
  ]);

  const result = cosign(tx, envelope({ ...FULL, fees: [fee(FEE_DEST, FEE_AMOUNT)] }));

  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

// ─── amounts as they actually cross the wire ───

test("a large amount reconciles exactly, past the point a double would round", () => {
  // 2^53 + 1. If either side of the comparison went through a JS number, this
  // would compare equal to 2^53 and a payment could be altered by one unit
  // without detection. bigint on both sides is what makes that impossible.
  const large = 9_007_199_254_740_993n;
  const tx = signedTx([transferTo(ata(RECIPIENT), large)]);

  const exact = cosign(tx, envelope({ ...FULL, amount: large.toString() }));
  assert.equal(exact.ok, true, exact.ok ? "" : exact.failure.message);

  const offByOne = cosign(tx, envelope({ ...FULL, amount: (large - 1n).toString() }));
  assert.equal(offByOne.ok, false, "a one-unit difference at this scale must be caught");
  if (offByOne.ok) return;
  assert.equal(offByOne.failure.code, "TRANSFER_AMOUNT_MISMATCH");
});

test("an amount sent as a JSON number is still accepted while it is exact", () => {
  // Compatibility, bounded. A client built before the SDK emitted strings sends
  // a number; refusing it would break every such client. Accepting it is safe
  // only while the value is a safe integer — past that the number has already
  // lost precision before it reached us, which the next test pins.
  const tx = signedTx([transferTo(ata(RECIPIENT), AMOUNT)]);

  const result = cosign(tx, envelope({ ...FULL, amount: Number(AMOUNT) }));

  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

test("REFUSES an amount whose numeric form has already lost precision", () => {
  // Above 2^53 a JSON number cannot represent the amount it claims to. Trusting
  // it would mean reconciling against a value that is not the one signed.
  const tx = signedTx([transferTo(ata(RECIPIENT), AMOUNT)]);

  const result = cosign(tx, envelope({ ...FULL, amount: 1e300 }));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_DECLARED_TERMS");
});

// ─── the thin envelope an un-rebuilt client still sends ───

test("with a thin envelope, a single transfer is still accepted", () => {
  // A client built before the queue exported terms sends `{ intentType }` and
  // nothing else, so there is nothing to reconcile against. This must keep
  // working or every such client breaks on deploy.
  const result = cosign(correctPayment(), envelope({ intentType: "Payment" }));

  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

test("but a thin envelope still cannot smuggle a second transfer", () => {
  // The materially stronger part. Even with nothing declared, the count is
  // known: one payment means one transfer. This is what closes the A1 hole for
  // clients that have not yet been updated to send full terms.
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(ATTACKER), 5_000_000n),
  ]);

  const result = cosign(tx, envelope({ intentType: "Payment" }));

  assert.equal(result.ok, false, "the count check must hold without declared terms");
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_COUNT_MISMATCH");
});

test("REFUSES a half-declared envelope rather than skipping the amount check", () => {
  // Recipient and asset declared, amount omitted. The tempting reading is
  // "check what is present, skip what is not" — but the client writes this
  // envelope, so that would let any client opt out of amount verification by
  // dropping one field. Absent is treated as 0, which pairs only with a
  // transfer that moves 0, so this is refused.
  //
  // No SDK produces this shape: the queue exports all four terms or none, and
  // the JS layer rejects a partial `terms` outright. A client sending it is
  // either broken or probing.
  const partial = { asset: MINT.toBase58(), recipient: RECIPIENT.toBase58() };

  const result = cosign(correctPayment(), envelope(partial));

  assert.equal(result.ok, false, "a half-declared envelope must not verify");
  if (result.ok) return;
  assert.equal(result.failure.code, "TRANSFER_AMOUNT_MISMATCH");
});

// ─── malformed input ───

test("REFUSES a transaction with no token instruction at all", () => {
  // `USER` is listed as a signer even though a memo needs no authority: the
  // signature gates run before the instruction check, so a transaction the user
  // is not a required signer of never reaches the code under test — it would
  // throw in `addSignature` instead, and the test would be asserting nothing.
  const memo = new TransactionInstruction({
    programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
    keys: [{ pubkey: USER.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from("not a payment"),
  });

  const result = cosign(signedTx([memo]), envelope(FULL));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "NO_MATCHING_TRANSFER_INSTRUCTION");
});

test("REFUSES declared terms that are not valid public keys", () => {
  const result = cosign(
    correctPayment(),
    envelope({ asset: "not-a-key", recipient: RECIPIENT.toBase58(), amount: AMOUNT.toString() }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_DECLARED_TERMS");
});

test("REFUSES a fee destination that is not a valid public key", () => {
  // Previously skipped with a `continue`, leaving the fee unrepresented in the
  // expected set — so the transfer paying it became an *undeclared* transfer
  // and the error named the wrong problem. Refusing outright is both safe and
  // legible: an unresolvable term cannot be reconciled.
  const tx = signedTx([
    transferTo(ata(RECIPIENT), AMOUNT),
    transferTo(ata(FEE_DEST), FEE_AMOUNT),
  ]);

  const result = cosign(
    tx,
    envelope({ ...FULL, fees: [{ destination: "not-a-key", amount: "10000" }] }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_DECLARED_TERMS");
  assert.match(result.failure.message, /fees\[0\]\.destination/);
});

test("REFUSES a declared amount that is not a number at all", () => {
  const result = cosign(
    correctPayment(),
    envelope({ ...FULL, amount: "not-a-number" }),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_DECLARED_TERMS");
});
