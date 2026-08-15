import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  MintLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { constructAndSignSettlement, loadDelegateKeypair } from "./settlement.js";
import { clearMintCache } from "./mintDecimals.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * The four gates that make relayer-built transactions safe.
 *
 * Everywhere else the user's signature covers the instruction bytes. Here it
 * does not — the relayer produces bytes the user has never seen — so the checks
 * are internal, and their *order* is the security argument: nothing is signed
 * until delegation, construction, and outbound verification have all passed. An
 * unsigned wrong transaction is an error; a signed one is a liability anyone
 * holding the bytes can submit.
 *
 * These drive a fake Connection so the SPL decoders do their real work on real
 * account layouts. Mocking `getAccount` or `getMint` instead would mock away the
 * exact decoding this path depends on.
 */

const DECIMALS = 6;
const MINT = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const SENDER = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const RECIPIENT = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
const FEE_DEST = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;

const DELEGATE = Keypair.fromSeed(new Uint8Array(32).fill(10));
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(11));
/** A valid delegate that is not ours. */
const OTHER_DELEGATE = Keypair.fromSeed(new Uint8Array(32).fill(12));

const SOURCE_ATA = getAssociatedTokenAddressSync(MINT, SENDER, false, TOKEN_PROGRAM_ID);
const BLOCKHASH = "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => silentLog,
} as never;

function encodeMint(): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000n,
      decimals: DECIMALS,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function encodeTokenAccount(
  fields: { delegate?: PublicKey | null; delegatedAmount?: bigint; amount?: bigint } = {},
): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  const delegate = fields.delegate === undefined ? DELEGATE.publicKey : fields.delegate;
  AccountLayout.encode(
    {
      mint: MINT,
      owner: SENDER,
      amount: fields.amount ?? 1_000_000_000n,
      delegateOption: delegate ? 1 : 0,
      delegate: delegate ?? PublicKey.default,
      delegatedAmount: fields.delegatedAmount ?? 1_000_000_000n,
      state: AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/** Serves the mint account and the sender's token account, nothing else. */
function fakeConnection(
  accountFields: Parameters<typeof encodeTokenAccount>[0] = {},
): Connection {
  return {
    getAccountInfo: async (address: PublicKey) => {
      const data = address.equals(MINT)
        ? encodeMint()
        : address.equals(SOURCE_ATA)
          ? encodeTokenAccount(accountFields)
          : null;
      if (!data) return null;
      return {
        data,
        executable: false,
        lamports: 2_039_280,
        owner: TOKEN_PROGRAM_ID,
        rentEpoch: 0,
      };
    },
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1 }),
  } as unknown as Connection;
}

function baseTerms(overrides: Record<string, unknown> = {}) {
  return {
    sender: SENDER.toBase58(),
    recipient: RECIPIENT.toBase58(),
    mint: MINT.toBase58(),
    amount: 1_000_000n,
    ...overrides,
  } as Parameters<typeof constructAndSignSettlement>[1];
}

function settle(
  terms = baseTerms(),
  accountFields: Parameters<typeof encodeTokenAccount>[0] = {},
) {
  clearMintCache();
  return constructAndSignSettlement(
    fakeConnection(accountFields),
    terms,
    DELEGATE,
    FEE_PAYER,
    silentLog,
  );
}

// ─── the happy path, end to end ───

test("builds, verifies, and signs a transfer the user authorised", async () => {
  // The whole of C2 in one assertion: an intent with no transaction becomes a
  // broadcast-ready transaction built against a fresh blockhash.
  const result = await settle();
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
  if (!result.ok) return;

  const tx = VersionedTransaction.deserialize(result.transaction);
  const message = tx.message.serialize();
  const signers = tx.message.staticAccountKeys.slice(
    0,
    tx.message.header.numRequiredSignatures,
  );

  // Every required signature must be present and verify — an unsigned slot
  // means the runtime rejects the transaction.
  assert.equal(tx.signatures.length, signers.length);
  signers.forEach((signer, i) => {
    assert.ok(
      nacl.sign.detached.verify(message, tx.signatures[i], signer.toBytes()),
      `slot ${i} does not verify under ${signer.toBase58()}`,
    );
  });

  assert.equal(result.totalDebit, 1_000_000n);
});

test("the sender never signs — being offline is the whole premise", async () => {
  const result = await settle();
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const tx = VersionedTransaction.deserialize(result.transaction);
  const signers = tx.message.staticAccountKeys.slice(
    0,
    tx.message.header.numRequiredSignatures,
  );
  assert.ok(
    !signers.some((k) => k.equals(SENDER)),
    "the sender cannot sign at settlement; authority comes from the delegate approval",
  );
  assert.ok(signers.some((k) => k.equals(DELEGATE.publicKey)));
  assert.ok(signers.some((k) => k.equals(FEE_PAYER.publicKey)));
});

test("fees settle in the same transaction, and count toward the debit", async () => {
  const result = await settle(
    baseTerms({ fees: [{ destination: FEE_DEST.toBase58(), amount: 10_000n }] }),
  );
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
  if (!result.ok) return;

  assert.equal(result.totalDebit, 1_010_000n, "debit is payment + fees");
  assert.equal(result.ataCreations, 2, "recipient and fee destination each need an account");
});

// ─── gate 1: delegation ───

test("REFUSES when the chain names a different delegate", async () => {
  // The case metadata.hw cannot catch: the intent is well-formed and correctly
  // signed, but the user never gave *us* authority.
  const result = await settle(baseTerms(), { delegate: OTHER_DELEGATE.publicKey });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "DELEGATE_MISMATCH");
});

test("REFUSES when the allowance does not cover payment plus fees", async () => {
  // A delegation sized for the payment alone must not settle a payment that
  // also moves a fee — the transfer would fail partway through, after the fee
  // payer had already spent.
  const result = await settle(
    baseTerms({ fees: [{ destination: FEE_DEST.toBase58(), amount: 10_000n }] }),
    { delegatedAmount: 1_000_000n },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "DELEGATION_EXHAUSTED");
});

test("the delegation is checked BEFORE anything is signed", async () => {
  // Ordering is the security property. A refusal returns no transaction at all,
  // so there are no signed bytes to leak or replay.
  const result = await settle(baseTerms(), { delegate: null });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(!("transaction" in result), "a refusal must not carry signed bytes");
});

// ─── gate 3: outbound verification ───

test("what gets signed is exactly what the intent describes", async () => {
  // The outbound guard re-derives destinations from raw PDA seeds rather than
  // reusing the construction helper, so this asserts the two agree on a real
  // signed transaction — the loop that was never closed while construction sat
  // dormant.
  const fees = [{ destination: FEE_DEST.toBase58(), amount: 25_000n }];
  const result = await settle(baseTerms({ fees }));
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
  if (!result.ok) return;

  const tx = VersionedTransaction.deserialize(result.transaction);
  const keys = tx.message.staticAccountKeys;
  const destinations = new Set(
    tx.message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex].equals(TOKEN_PROGRAM_ID))
      .map((ix) => keys[ix.accountKeyIndexes[2]].toBase58()),
  );

  assert.ok(
    destinations.has(
      getAssociatedTokenAddressSync(MINT, RECIPIENT, false, TOKEN_PROGRAM_ID).toBase58(),
    ),
    "the payment must reach the recipient's ATA",
  );
  assert.ok(
    destinations.has(
      getAssociatedTokenAddressSync(MINT, FEE_DEST, false, TOKEN_PROGRAM_ID).toBase58(),
    ),
    "the fee must reach the fee destination's ATA",
  );
  assert.equal(destinations.size, 2, "and nothing else may receive value");
});

// ─── inputs that cannot be settled ───

test("REFUSES an unresolvable mint rather than guessing decimals", async () => {
  // Guessing would move the wrong amount by a power of ten.
  const unknownMint = Keypair.fromSeed(new Uint8Array(32).fill(99)).publicKey;
  const result = await settle(baseTerms({ mint: unknownMint.toBase58() }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "MINT_UNRESOLVED");
});

test("REFUSES an unparseable sender or mint", async () => {
  const result = await settle(baseTerms({ sender: "not-a-key" }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INVALID_SETTLEMENT_ADDRESS");
  assert.equal(result.failure.stage, RelayerFailureStage.Validation);
});

// ─── the delegate key itself ───

test("loadDelegateKeypair refuses to fall back to the fee payer", async () => {
  // The most dangerous available default. Silently using the fee-paying key
  // would give it drain authority over every delegated balance.
  assert.throws(
    () => loadDelegateKeypair({ FEE_PAYER_SECRET_KEY: "[1,2,3]" } as never),
    /not set/,
  );
});

test("loadDelegateKeypair rejects a malformed key rather than proceeding", () => {
  assert.throws(
    () => loadDelegateKeypair({ DELEGATE_SECRET_KEY: "not-json" } as never),
    /JSON array/,
  );
  assert.throws(
    () => loadDelegateKeypair({ DELEGATE_SECRET_KEY: '["a","b"]' } as never),
    /byte values/,
  );
});

test("loadDelegateKeypair loads a real key", () => {
  const loaded = loadDelegateKeypair({
    DELEGATE_SECRET_KEY: JSON.stringify(Array.from(DELEGATE.secretKey)),
  } as never);
  assert.equal(loaded.publicKey.toBase58(), DELEGATE.publicKey.toBase58());
});
