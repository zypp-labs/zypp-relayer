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
import {
  coSignAsFeePayerWithKeys,
  loadFeePayerKeypairs,
} from "./feePayer.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * Fee-payer rotation.
 *
 * A client bakes the fee payer's public key into the message it signs. The old
 * single-key gate compared against one key, so rotation permanently invalidated
 * every already-signed transaction naming the previous one. With a 120-day
 * intent TTL that is not an edge case — it is a guarantee. These tests pin the
 * multi-key behaviour that makes rotation a drain rather than a cutover.
 */

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Three fee-payer generations: current, rotating-out, and the next one being
// staged. Derived from fixed 32-byte seeds so assertions are stable across runs
// (fromSecretKey expects the full 64-byte expanded key; fromSeed takes 32).
const CURRENT = Keypair.fromSeed(
  Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1)),
);
const LEGACY = Keypair.fromSeed(
  Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 101)),
);
const STAGED = Keypair.fromSeed(
  Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 201)),
);

/** Serialize a keypair the way config carries it: a JSON array of 64 bytes. */
function asSecretJson(kp: Keypair): string {
  return JSON.stringify(Array.from(kp.secretKey));
}

function mockConfig(extra?: string) {
  return {
    FEE_PAYER_SECRET_KEY: asSecretJson(CURRENT),
    ...(extra ? { FEE_PAYER_LEGACY_SECRET_KEYS: extra } : {}),
  };
}

/** The user whose signature authorises the transfer. */
const USER = Keypair.fromSeed(new Uint8Array(32).fill(42));

/**
 * A partially-signed transaction naming `feePayer`, carrying a genuine user
 * signature.
 *
 * The signature has to be real. Step 4 of the co-sign sequence Ed25519-verifies
 * the user signature and returns `USER_SIG_INVALID` before step 5 ever looks at
 * the fee payer — so a placeholder signature short-circuits every test into the
 * wrong branch and proves nothing about key selection.
 */
function signedTx(feePayer: Keypair): { bytes: Buffer; message: Uint8Array } {
  // Real generated keys — an invented base58 string is not a valid curve point
  // and PublicKey rejects it.
  const source = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const destination = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey;

  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
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
  const messageBytes = tx.message.serialize();
  // Signature `i` belongs to signer `i`. USER compiles to index 1 — the fee
  // payer takes 0 — so `addSignature` puts it there and leaves slot 0 empty for
  // the relayer, which is what a correctly partial-signing client produces.
  // This used to write into slot 0, matching a co-signer that read the fee
  // payer's own slot and then appended its signature past the end of the array.
  tx.addSignature(USER.publicKey, nacl.sign.detached(messageBytes, USER.secretKey));
  return { bytes: Buffer.from(tx.serialize()), message: messageBytes };
}

/** The envelope names the signer whose signature step 4 verifies. */
function envelopeFor(user: Keypair) {
  return {
    version: 1,
    network: "solana",
    intent: "payment",
    payload: {},
    signature: {
      publicKey: user.publicKey.toBase58(),
      signature: "unused-by-cosign",
      nonce: 1,
    },
  };
}

/** Advance through the gates to observe only the fee-payer selection result. */
function feePayerDecision(
  tx: Buffer,
  keys: Keypair[],
): { ok: boolean; feePayer?: string; code?: string } {
  const result = coSignAsFeePayerWithKeys(tx, envelopeFor(USER) as any, keys);
  if (result.ok) return { ok: true, feePayer: result.feePayer };
  return { ok: false, code: result.failure.code };
}

// ─── loadFeePayerKeypairs ───

test("loads the primary key and orders it first", () => {
  const { keypairs, primary } = loadFeePayerKeypairs(mockConfig());
  assert.equal(primary.publicKey.toBase58(), CURRENT.publicKey.toBase58());
  assert.equal(keypairs.length, 1);
  assert.equal(keypairs[0].publicKey.toBase58(), CURRENT.publicKey.toBase58());
});

test("accepts a single legacy key as a flat byte array", () => {
  // REGRESSION. The first implementation comma-split this string, but a JSON
  // byte array is full of commas — `[101,102,...]` shredded into `["[101",
  // "102", ...]` and every legacy key failed to parse. Legacy keys were
  // completely non-functional.
  //
  // This flat shape is also what an operator actually produces during a
  // rotation (`cat fee-payer-old.json`), so it has to be the easy path.
  const { keypairs } = loadFeePayerKeypairs(mockConfig(asSecretJson(LEGACY)));
  assert.deepEqual(
    keypairs.map((k) => k.publicKey.toBase58()),
    [CURRENT, LEGACY].map((k) => k.publicKey.toBase58()),
  );
});

test("accepts several legacy keys as an array of byte arrays, in order", () => {
  const { keypairs } = loadFeePayerKeypairs(
    mockConfig(JSON.stringify([Array.from(LEGACY.secretKey), Array.from(STAGED.secretKey)])),
  );
  assert.deepEqual(
    keypairs.map((k) => k.publicKey.toBase58()),
    [CURRENT, LEGACY, STAGED].map((k) => k.publicKey.toBase58()),
  );
});

test("ignores a legacy entry duplicating the primary", () => {
  const { keypairs } = loadFeePayerKeypairs(mockConfig(asSecretJson(CURRENT)));
  assert.equal(keypairs.length, 1);
});

test("ignores an absent or whitespace-only legacy value", () => {
  assert.equal(loadFeePayerKeypairs(mockConfig()).keypairs.length, 1);
  assert.equal(loadFeePayerKeypairs(mockConfig("   ")).keypairs.length, 1);
});

test("ignores an empty legacy array", () => {
  assert.equal(loadFeePayerKeypairs(mockConfig("[]")).keypairs.length, 1);
});

test("throws on an unparseable legacy key rather than proceeding without it", () => {
  // A silently-dropped legacy key strands exactly the transactions it exists
  // to rescue. Missing must be fatal, not tolerated.
  assert.throws(() => loadFeePayerKeypairs(mockConfig("not-json")), SyntaxError);
});

test("throws on a legacy value that parses but is not bytes", () => {
  assert.throws(() => loadFeePayerKeypairs(mockConfig("42")), /must be a JSON array/);
  assert.throws(() => loadFeePayerKeypairs(mockConfig('["a","b"]')), /byte values/);
});

// ─── co-signing: the rotation cases ───

test("co-signs a transaction naming the current key", () => {
  const result = feePayerDecision(signedTx(CURRENT).bytes, [CURRENT, LEGACY]);
  assert.equal(result.ok, true);
  assert.equal(result.feePayer, CURRENT.publicKey.toBase58());
});

test("co-signs a transaction naming a legacy key — the case single-key broke", () => {
  // Before this change the gate compared against the one current key, so a
  // client that signed against the pre-rotation key was permanently refused.
  const result = feePayerDecision(signedTx(LEGACY).bytes, [CURRENT, LEGACY]);
  assert.equal(result.ok, true);
  assert.equal(result.feePayer, LEGACY.publicKey.toBase58());
});

test("signs with the key the transaction names, not always the primary", () => {
  // Selecting the wrong key would produce a transaction Solana rejects for a
  // missing/mismatched signature — subtle and bad. The choice must follow the
  // transaction, and the appended signature must verify under that key.
  const { bytes, message } = signedTx(LEGACY);
  const result = coSignAsFeePayerWithKeys(bytes, envelopeFor(USER) as any, [CURRENT, LEGACY]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.feePayer, LEGACY.publicKey.toBase58());

  // Scan for the signature rather than computing an offset. The wire format is
  // [compact-u16 count][64-byte signatures...][message], and the count's own
  // width changes as signatures are appended — so a fixed offset is brittle.
  // Sliding a 64-byte window is immune to all of that.
  const verifiesUnder = (key: Keypair): boolean => {
    for (let i = 0; i + 64 <= result.tx.length; i++) {
      const candidate = result.tx.subarray(i, i + 64);
      if (nacl.sign.detached.verify(message, candidate, key.publicKey.toBytes())) {
        return true;
      }
    }
    return false;
  };

  assert.ok(
    verifiesUnder(LEGACY),
    "the transaction must carry a signature verifying under the key it named",
  );
  assert.ok(
    !verifiesUnder(CURRENT),
    "and must not have been signed by the primary key instead",
  );
});

test("refuses a transaction naming an unknown fee payer", () => {
  const result = feePayerDecision(signedTx(STAGED).bytes, [CURRENT, LEGACY]);
  assert.equal(result.ok, false);
  assert.equal(result.code, "FEE_PAYER_MISMATCH");
});

test("FEE_PAYER_MISMATCH lists the accepted keys and the remedy", () => {
  const result = coSignAsFeePayerWithKeys(
    signedTx(STAGED).bytes,
    envelopeFor(USER) as any,
    [CURRENT, LEGACY],
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.stage, RelayerFailureStage.FeePayerCheck);
  assert.equal(result.failure.retriable, false);
  assert.match(result.failure.message, new RegExp(CURRENT.publicKey.toBase58()));
  assert.match(result.failure.message, new RegExp(LEGACY.publicKey.toBase58()));
  assert.match(result.failure.message, /FEE_PAYER_LEGACY_SECRET_KEYS/);
});

test("refuses when no fee payer is configured at all", () => {
  const result = feePayerDecision(signedTx(CURRENT).bytes, []);
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_FEE_PAYER_CONFIGURED");
});
