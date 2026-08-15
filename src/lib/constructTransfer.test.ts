import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildDelegatedTransfer } from "./constructTransfer.js";
import {
  verifyConstructedTransaction,
  ConstructedTransactionMismatchError,
  extractTransferValue,
} from "./outboundVerification.js";

/**
 * Relayer-side transaction construction, checked against the independent
 * outbound guard.
 *
 * The pairing is the point. `constructTransfer.ts` derives the destination ATA
 * with `getAssociatedTokenAddressSync`; `outboundVerification.ts` re-derives it
 * from raw PDA seeds precisely so it cannot inherit a bug from that helper. If
 * the two ever disagree, one of them is wrong and these tests fail rather than a
 * user's funds landing somewhere they did not agree to.
 *
 * That guard has 19 tests of its own but had never been run against a real
 * constructed transaction — nothing called it. These are the tests that close
 * the loop.
 */

const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK";

const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
/** The account the user approved on their token account. */
const DELEGATE = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const SENDER = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;
/** Devnet USDC — 6 decimals, the asset every real intent moves today. */
const USDC = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

function build(overrides: Partial<Parameters<typeof buildDelegatedTransfer>[0]> = {}) {
  return buildDelegatedTransfer({
    sender: SENDER.toBase58(),
    recipient: RECIPIENT.toBase58(),
    mint: USDC.toBase58(),
    amount: 1_500_000n, // 1.5 USDC
    decimals: 6,
    feePayer: FEE_PAYER,
    delegate: DELEGATE,
    recentBlockhash: BLOCKHASH,
    ...overrides,
  });
}

function terms(overrides: Record<string, unknown> = {}): Parameters<typeof verifyConstructedTransaction>[0] {
  return {
    amount: 1_500_000n,
    asset: USDC.toBase58(),
    recipient: RECIPIENT.toBase58(),
    ...overrides,
  };
}

/**
 * Run `fn`, assert it threw a mismatch, and hand back the error.
 *
 * `assert.throws` is typed `void`, so it cannot be used to inspect a message.
 * Several tests here assert on the *wording* rather than just the class, because
 * which side of the reconciliation failed is the diagnostic — "a fee is missing"
 * and "a fee was redirected" are different incidents.
 */
function expectMismatch(fn: () => void): ConstructedTransactionMismatchError {
  try {
    fn();
  } catch (e) {
    assert.ok(
      e instanceof ConstructedTransactionMismatchError,
      `expected ConstructedTransactionMismatchError, got ${e}`,
    );
    return e;
  }
  assert.fail("expected a ConstructedTransactionMismatchError, but nothing was thrown");
}

// ─── construction and the guard agree ───

test("a constructed transfer passes the independent outbound guard", () => {
  // The whole reason the guard exists. It re-derives the destination from PDA
  // seeds rather than reusing the SPL helper, so this asserts the two derivations
  // agree on a real transaction — not that one of them is self-consistent.
  const { serialized } = build();
  assert.doesNotThrow(() => verifyConstructedTransaction(terms(), serialized));
});

test("the guard rejects the same transaction against different terms", () => {
  // Guards the guard: if verification passed everything, the test above would be
  // meaningless. One base unit of difference must be caught.
  const { serialized } = build();
  assert.throws(
    () => verifyConstructedTransaction(terms({ amount: 1_500_001n }), serialized),
    ConstructedTransactionMismatchError,
  );
});

test("a transfer to a different recipient does not verify against the original", () => {
  // This used to be a destination mismatch inside a one-transfer check. Now it
  // is set reconciliation: the intended recipient is unpaired AND an
  // undeclared destination appears. The message must say both, because "a
  // transfer is missing" alone would hide that funds are going somewhere else
  // instead — equal counts on both sides is exactly the shape of redirected
  // value, not dropped value.
  const other = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const { serialized } = build({ recipient: other.toBase58() });
  const err = expectMismatch(() => verifyConstructedTransaction(terms(), serialized));
  assert.match(err.message, /Required but absent/);
  assert.match(err.message, /Present but undeclared/);
  assert.match(err.message, /destination or amount was changed/);
});

test("a transfer of a different mint does not verify against the original", () => {
  // Both the mint operand and the derived ATA change, so this is caught twice.
  const otherMint = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;
  const { serialized } = build({ mint: otherMint.toBase58() });
  assert.throws(() => verifyConstructedTransaction(terms(), serialized));
});

// ─── the shape of what gets built ───

test("the fee payer is staticAccountKeys[0], as the co-signer requires", () => {
  // coSignAsFeePayerWithKeys reads the fee payer from slot 0 and refuses a
  // transaction naming a key it does not hold. Construction has to agree.
  const { transaction } = build();
  assert.ok(transaction.message.staticAccountKeys[0].equals(FEE_PAYER));
});

test("the delegate is the transfer authority, not the sender", () => {
  // The user is offline and cannot sign. The move is authorised by the on-chain
  // approval they granted earlier, which names the delegate — so the delegate
  // must be the authority account, or the token program refuses.
  const { transaction, serialized } = build();
  const tx = VersionedTransaction.deserialize(serialized);
  const signers = tx.message.staticAccountKeys.slice(
    0,
    tx.message.header.numRequiredSignatures,
  );

  assert.ok(
    signers.some((k) => k.equals(DELEGATE)),
    "the delegate must be a required signer — it authorises the transfer",
  );
  assert.ok(
    !signers.some((k) => k.equals(SENDER)),
    "the sender must NOT be required to sign; they are offline, which is the entire premise",
  );
  assert.equal(transaction.message.header.numRequiredSignatures, signers.length);
});

test("every signature slot starts empty, so the result is unsigned", () => {
  // Construction must not sign. Signing happens after verification, and a
  // pre-signed slot would let a caller skip the guard without noticing.
  const { transaction } = build();
  assert.equal(
    transaction.signatures.length,
    transaction.message.header.numRequiredSignatures,
  );
  for (const sig of transaction.signatures) {
    assert.ok(sig.every((b) => b === 0), "signature slots must be zero-filled");
  }
});

test("the recipient ATA is derived, never taken from the caller", () => {
  const { destinationAta, sourceAta } = build();
  assert.notEqual(destinationAta.toBase58(), RECIPIENT.toBase58());
  assert.notEqual(sourceAta.toBase58(), SENDER.toBase58());
});

test("the amount is carried exactly, with no float rounding", () => {
  // bigint end to end. A u64 amount past 2^53 survives here and would not if
  // anything on the path touched Number.
  const big = 9_007_199_254_740_993n; // 2^53 + 1
  const { serialized } = build({ amount: big });
  assert.equal(extractTransferValue(serialized)?.amount, big);
});

// ─── the recipient ATA problem (A2) ───

test("by default the recipient's ATA is created idempotently", () => {
  // to-be-fixed A2: without this, paying anyone who does not already hold the
  // mint fails deterministically at simulation. Idempotent, so an existing
  // account is a no-op rather than a race.
  const { transaction } = build();
  const programIds = transaction.message.compiledInstructions.map((ci) =>
    transaction.message.staticAccountKeys[ci.programIdIndex].toBase58(),
  );
  assert.equal(programIds.length, 2, "expected an ATA create plus the transfer");
  assert.ok(
    programIds.includes("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    "the Associated Token Account program must appear",
  );
});

test("the ATA create does not upset the guard's one-token-instruction rule", () => {
  // The guard refuses more than one *SPL token* instruction, because extras
  // could move value the intent never described. The ATA create belongs to the
  // Associated Token program, so it is correctly not counted — but that is a
  // real interaction between two files and worth pinning.
  const { serialized } = build({ createRecipientAta: true });
  assert.doesNotThrow(() => verifyConstructedTransaction(terms(), serialized));
});

test("ATA creation can be turned off, and the transfer still verifies", () => {
  const { transaction, serialized } = build({ createRecipientAta: false });
  assert.equal(transaction.message.compiledInstructions.length, 1);
  assert.doesNotThrow(() => verifyConstructedTransaction(terms(), serialized));
});

test("the fee payer funds the ATA rent, not the offline sender", () => {
  // The sender cannot sign, so they cannot pay rent. Charging them would make
  // the instruction unsatisfiable; the relayer absorbs it, which is what the
  // rolling SOL budget reserves against.
  const { transaction } = build();
  const create = transaction.message.compiledInstructions[0];
  const payer = transaction.message.staticAccountKeys[create.accountKeyIndexes[0]];
  assert.ok(payer.equals(FEE_PAYER));
});

// ─── Token-2022 ───

test("a Token-2022 mint is addressed with its own program", () => {
  // A Token-2022 mint queried under the classic program fails, and the ATA
  // derivation differs because the token program is one of the PDA seeds.
  const { serialized, destinationAta } = build({ tokenProgramId: TOKEN_2022_PROGRAM_ID });

  const classic = build({ tokenProgramId: TOKEN_PROGRAM_ID }).destinationAta;
  assert.notEqual(
    destinationAta.toBase58(),
    classic.toBase58(),
    "the token program is a PDA seed, so the two ATAs must differ",
  );

  assert.doesNotThrow(() => verifyConstructedTransaction(terms(), serialized));
});

// ─── rejected inputs ───

test("a zero or negative amount is refused at construction", () => {
  assert.throws(() => build({ amount: 0n }), /must be positive/);
  assert.throws(() => build({ amount: -1n }), /must be positive/);
});

test("an invalid address names which field was wrong", () => {
  // These arrive from a decoded intent, so a bad one is a data problem someone
  // has to diagnose from a log line.
  assert.throws(() => build({ recipient: "not-a-key" }), /recipient/);
  assert.throws(() => build({ sender: "not-a-key" }), /sender/);
  assert.throws(() => build({ mint: "not-a-key" }), /mint/);
});

test("decimals must be resolved, not guessed", () => {
  // TransferChecked fails on-chain if decimals disagree with the mint. A
  // fractional or out-of-range value is a caller bug worth naming here.
  assert.throws(() => build({ decimals: 6.5 }), /decimals/);
  assert.throws(() => build({ decimals: -1 }), /decimals/);
  assert.throws(() => build({ decimals: 19 }), /decimals/);
});

test("decimals of 0 is valid — not every mint has six", () => {
  // Guards against a truthiness check creeping in. NFTs and many SPL mints are
  // 0-decimal, and `if (!decimals)` would reject them.
  assert.doesNotThrow(() => build({ decimals: 0, amount: 5n }));
});

// ─── signed fees ───

/** Two fee destinations: Zypp's own cut and a developer's platform fee. */
const ZYPP_FEE_DEST = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
const DEV_FEE_DEST = Keypair.fromSeed(new Uint8Array(32).fill(22)).publicKey;

const ZYPP_FEE = { destination: ZYPP_FEE_DEST.toBase58(), amount: 10_000n };
const DEV_FEE = { destination: DEV_FEE_DEST.toBase58(), amount: 25_000n };

test("a payment with no fees is unchanged — one transfer, one ATA create", () => {
  // The ordinary peer-to-peer case must not have been disturbed by adding fees.
  const { transaction, ataCreationCount } = build();
  assert.equal(transaction.message.compiledInstructions.length, 2);
  assert.equal(ataCreationCount, 1);
  assert.doesNotThrow(() => verifyConstructedTransaction(terms(), build().serialized));
});

test("one fee produces a second transfer, and the guard accepts it", () => {
  const { serialized, feeAtas } = build({ fees: [ZYPP_FEE] });
  assert.equal(feeAtas.length, 1);
  assert.doesNotThrow(() =>
    verifyConstructedTransaction(terms({ fees: [ZYPP_FEE] }), serialized),
  );
});

test("Zypp's fee and a developer's fee settle in the same transaction", () => {
  // The point of the unified model: neither party is privileged in the payload,
  // and a marketplace split later is just more entries.
  const { serialized, transaction, ataCreationCount } = build({
    fees: [ZYPP_FEE, DEV_FEE],
  });

  // 3 ATA creates (recipient + 2 fee destinations) + 3 transfers.
  assert.equal(transaction.message.compiledInstructions.length, 6);
  assert.equal(ataCreationCount, 3);
  assert.doesNotThrow(() =>
    verifyConstructedTransaction(terms({ fees: [ZYPP_FEE, DEV_FEE] }), serialized),
  );
});

test("REJECTS a transaction missing a fee the intent declared", () => {
  // The half that is easy to overlook. If construction silently dropped a fee,
  // the payment would settle while a party the user agreed to pay went unpaid,
  // and the transaction would look perfectly valid on-chain.
  const built = build({ fees: [ZYPP_FEE] }); // only Zypp's fee constructed
  assert.throws(
    () => verifyConstructedTransaction(terms({ fees: [ZYPP_FEE, DEV_FEE] }), built.serialized),
    /missing 1 transfer/,
  );
});

test("REJECTS an undeclared extra transfer — the original protection", () => {
  // This must not regress. It is why the guard existed before fees, and the
  // set-based rewrite has to preserve it exactly.
  const built = build({ fees: [ZYPP_FEE, DEV_FEE] });
  assert.throws(
    () => verifyConstructedTransaction(terms({ fees: [ZYPP_FEE] }), built.serialized),
    /does not describe/,
  );
});

test("REJECTS a fee redirected to another wallet", () => {
  // Same count, same amounts, one destination changed — the subtlest tampering
  // and the one a count-based check would wave through. Both sides of the
  // reconciliation are non-empty, so the error must name the redirection rather
  // than report a bare absence.
  const built = build({ fees: [{ ...ZYPP_FEE, destination: DEV_FEE_DEST.toBase58() }] });
  const err = expectMismatch(() =>
    verifyConstructedTransaction(terms({ fees: [ZYPP_FEE] }), built.serialized),
  );
  assert.match(err.message, /Required but absent/);
  assert.match(err.message, /Present but undeclared/);
});

test("REJECTS a fee whose amount was altered", () => {
  const built = build({ fees: [{ ...ZYPP_FEE, amount: ZYPP_FEE.amount + 1n }] });
  const err = expectMismatch(() =>
    verifyConstructedTransaction(terms({ fees: [ZYPP_FEE] }), built.serialized),
  );
  assert.match(err.message, /destination or amount was changed/);
});

test("two identical fees require two matching transfers", () => {
  // Duplicate (destination, amount) pairs are where a set-membership check
  // quietly differs from a bijection: matching by "is it present" would accept
  // one instruction for two expected entries, paying the party once.
  const twice = [ZYPP_FEE, { ...ZYPP_FEE }];
  const { serialized } = build({ fees: twice });
  assert.doesNotThrow(() => verifyConstructedTransaction(terms({ fees: twice }), serialized));

  const onlyOnce = build({ fees: [ZYPP_FEE] });
  assert.throws(
    () => verifyConstructedTransaction(terms({ fees: twice }), onlyOnce.serialized),
    /missing 1 transfer/,
  );
});

test("a fee paid to the payment recipient does not duplicate the ATA create", () => {
  // Idempotent on-chain either way, but a duplicate create would inflate the
  // rent reservation and misdescribe what the transaction does.
  const { ataCreationCount, transaction } = build({
    fees: [{ destination: RECIPIENT.toBase58(), amount: 10_000n }],
  });
  assert.equal(ataCreationCount, 1, "one destination account means one create");
  // 1 create + 2 transfers.
  assert.equal(transaction.message.compiledInstructions.length, 3);
});

test("the total debit is the payment plus every fee", () => {
  // Nothing carries the total as its own field, so it cannot disagree with the
  // parts. This pins the arithmetic the SOL budget and ceilings depend on.
  const { serialized } = build({ fees: [ZYPP_FEE, DEV_FEE] });
  assert.equal(
    extractTransferValue(serialized)?.amount,
    1_500_000n + ZYPP_FEE.amount + DEV_FEE.amount,
  );
});

test("a zero or negative fee is refused at construction", () => {
  assert.throws(() => build({ fees: [{ ...ZYPP_FEE, amount: 0n }] }), /fees\[0\]/);
  assert.throws(() => build({ fees: [{ ...ZYPP_FEE, amount: -1n }] }), /fees\[0\]/);
});

test("an invalid fee destination names which entry was wrong", () => {
  assert.throws(
    () => build({ fees: [ZYPP_FEE, { destination: "not-a-key", amount: 5n }] }),
    /fees\[1\]\.destination/,
  );
});
