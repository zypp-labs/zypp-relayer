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
  verifyConstructedTransaction,
  ConstructedTransactionMismatchError,
  type PaymentIntentTerms,
} from "./outboundVerification.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * The backstop for "what if the construction logic itself has a bug."
 *
 * Once the relayer builds transactions, the user's signature no longer covers
 * the instruction bytes — so a construction defect would move the wrong amount
 * or pay the wrong account with nothing external to stop it. Every test that
 * deliberately builds a *wrong* transaction and asserts rejection is load
 * bearing: if one of them starts passing a bad transaction, funds move
 * incorrectly in production.
 */

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

// Fixed keys — deterministic failure output, no RNG in assertions.
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC mainnet
const OTHER_MINT = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL
const RECIPIENT = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const ATTACKER = new PublicKey("6dNVEJ741qHmZ8dppzBoRKPnyGWHFMWEbEZbtRfyxLLL");
const SENDER = new PublicKey("11111111111111111111111111111112");
const FEE_PAYER = Keypair.generate();

const AMOUNT = 1_500_000n; // 1.5 USDC in base units

function ata(owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), program.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return addr;
}

function transferData(amount: bigint, discriminator = 3): Buffer {
  const data = Buffer.alloc(9);
  data[0] = discriminator;
  data.writeBigUInt64LE(amount, 1);
  return data;
}

function transferCheckedData(amount: bigint, decimals = 6): Buffer {
  const data = Buffer.alloc(10);
  data[0] = 12;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return data;
}

function key(pubkey: PublicKey, isWritable = true) {
  return { pubkey, isSigner: false, isWritable };
}

/** Serialize instructions into a VersionedTransaction the verifier can read. */
function build(instructions: TransactionInstruction[]): Buffer {
  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK",
    instructions,
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize());
}

/** A correct SPL Transfer expressing the canonical intent. */
function correctTransfer(): Buffer {
  return build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
}

const INTENT: PaymentIntentTerms = {
  amount: AMOUNT,
  asset: MINT.toBase58(),
  recipient: RECIPIENT.toBase58(),
};

function expectMismatch(tx: Buffer, pattern: RegExp, intent: PaymentIntentTerms = INTENT) {
  assert.throws(
    () => verifyConstructedTransaction(intent, tx),
    (err: unknown) => {
      assert.ok(
        err instanceof ConstructedTransactionMismatchError,
        `expected ConstructedTransactionMismatchError, got ${(err as Error)?.name}`,
      );
      assert.match(err.message, pattern);
      return true;
    },
  );
}

// ─── The happy path must pass, or every rejection below is meaningless ───

test("accepts a correctly constructed Transfer", () => {
  verifyConstructedTransaction(INTENT, correctTransfer());
});

test("accepts a correctly constructed TransferChecked", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(MINT, false),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferCheckedData(AMOUNT),
    }),
  ]);
  verifyConstructedTransaction(INTENT, tx);
});

test("accepts Token-2022 when the mint matches", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT, TOKEN_2022_PROGRAM_ID)),
        key(ata(RECIPIENT, MINT, TOKEN_2022_PROGRAM_ID)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
  verifyConstructedTransaction(INTENT, tx);
});

// ─── THE CRITICAL CASES: wrong recipient, wrong amount ───

test("REJECTS a transfer to the wrong recipient", () => {
  // The construction bug that matters most: right amount, right mint, wrong
  // destination. Funds leave the user's account and never arrive.
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(ATTACKER, MINT)), // ← wrong
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
  // Equal amounts on both sides, different destination: the reconciler must
  // report this as a redirect, naming both the owed ATA and the one that got
  // paid instead. "A transfer is missing" alone would omit where funds went.
  expectMismatch(
    tx,
    /Required but absent: payment \(1500000 .*Present but undeclared: instruction 0 \(1500000 /,
  );
});

test("REJECTS a transfer of the wrong amount", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT * 1000n), // ← 1000x
    }),
  ]);
  // Both amounts must appear, and on the correct side of the report: owed
  // 1500000, actually sending 1000× that.
  expectMismatch(
    tx,
    /Required but absent: payment \(1500000 .*Present but undeclared: instruction 0 \(1500000000 /,
  );
});

test("REJECTS an amount off by a single base unit", () => {
  // Exactness, not approximation. One lamport of drift is still a mismatch.
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT + 1n),
    }),
  ]);
  expectMismatch(
    tx,
    /Required but absent: payment \(1500000 .*Present but undeclared: instruction 0 \(1500001 /,
  );
});

test("REJECTS a transfer of the wrong asset", () => {
  // A different mint yields a different destination ATA, so the wrong-asset
  // case is caught even on a bare Transfer where mint is not an operand.
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, OTHER_MINT)),
        key(ata(RECIPIENT, OTHER_MINT)), // ← ATA of the wrong mint
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
  expectMismatch(
    tx,
    /transfers do not match the intent.*Present but undeclared: instruction 0 /,
  );
});

test("REJECTS TransferChecked whose mint operand disagrees with the intent", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(OTHER_MINT, false), // ← wrong mint operand
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferCheckedData(AMOUNT),
    }),
  ]);
  expectMismatch(tx, /mint mismatch/);
});

// ─── Smuggled extra value ───

test("REJECTS a second token transfer smuggled alongside the intended one", () => {
  // The intent authorises one transfer. A second, even to the correct
  // recipient, moves value the user never agreed to.
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(ATTACKER, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
  // Reconciliation, not counting: the legitimate transfer pairs off against the
  // intent and is consumed, so the report points at instruction 1 specifically
  // rather than saying "found 2 where 1 was expected".
  expectMismatch(tx, /contains 1 transfer\(s\) the intent does not describe: instruction 1 /);
});

test("tolerates a non-token instruction accompanying the transfer", () => {
  // A memo or compute-budget instruction moves no value; only token
  // instructions are counted.
  const tx = build([
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from("zypp", "utf8"),
    }),
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT),
    }),
  ]);
  verifyConstructedTransaction(INTENT, tx);
});

// ─── Structural rejections ───

test("REJECTS a transaction with no token instruction", () => {
  const tx = build([
    new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from("nothing to see", "utf8"),
    }),
  ]);
  expectMismatch(tx, /no SPL token instruction/);
});

test("REJECTS a non-transfer token instruction", () => {
  // Discriminator 7 is MintTo — not a transfer, must not pass.
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(MINT),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: transferData(AMOUNT, 7),
    }),
  ]);
  expectMismatch(tx, /discriminator 7\b.*neither Transfer/);
});

test("REJECTS instruction data too short to hold an amount", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        key(ata(SENDER, MINT)),
        key(ata(RECIPIENT, MINT)),
        key(SENDER, false),
      ],
      data: Buffer.from([3, 0, 0]),
    }),
  ]);
  expectMismatch(tx, /too short to contain a u64 amount/);
});

test("REJECTS a Transfer with too few accounts", () => {
  const tx = build([
    new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [key(ata(SENDER, MINT)), key(ata(RECIPIENT, MINT))],
      data: transferData(AMOUNT),
    }),
  ]);
  expectMismatch(tx, /needs at least 3 accounts/);
});

test("REJECTS undeserializable bytes", () => {
  expectMismatch(Buffer.from([0xff, 0xfe, 0xfd]), /failed to deserialize/);
});

// ─── Intent-side validation ───

test("REJECTS a malformed recipient in the intent", () => {
  expectMismatch(
    correctTransfer(),
    /recipient 'not-a-pubkey' is not a valid public key/,
    { ...INTENT, recipient: "not-a-pubkey" },
  );
});

test("REJECTS a malformed asset in the intent", () => {
  expectMismatch(
    correctTransfer(),
    /asset 'nope' is not a valid public key/,
    { ...INTENT, asset: "nope" },
  );
});

test("REJECTS a zero-amount intent", () => {
  expectMismatch(correctTransfer(), /amount must be positive/, { ...INTENT, amount: 0n });
});

// ─── Failure metadata ───

test("carries the OutboundVerification stage and CONSTRUCTED_TX_MISMATCH code", () => {
  // The job row must record this distinctly from every other failure mode, so
  // a construction defect is findable in the failure data rather than buried
  // among broadcast errors.
  try {
    verifyConstructedTransaction({ ...INTENT, amount: 999n }, correctTransfer());
    assert.fail("expected a mismatch");
  } catch (err) {
    assert.ok(err instanceof ConstructedTransactionMismatchError);
    assert.equal(err.failure.stage, RelayerFailureStage.OutboundVerification);
    assert.equal(err.failure.code, "CONSTRUCTED_TX_MISMATCH");
    assert.equal(err.failure.retriable, false, "a deterministic defect must not be retried");
    assert.equal(err.name, "ConstructedTransactionMismatchError");
  }
});
