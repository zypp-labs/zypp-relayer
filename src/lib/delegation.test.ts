import test from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  AccountState,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { verifyDelegation } from "./delegation.js";
import { RelayerFailureStage } from "./failureCodes.js";

/**
 * The gate that decides whether the relayer may move a user's tokens.
 *
 * In the offline-first model the user is absent at settlement, so authority
 * comes from an SPL delegate approval they granted earlier while online. The
 * tempting shortcut is to trust the intent's `metadata.hw` field, which names
 * the hot wallet the client *says* was approved — but that field is not covered
 * by the user's signature (`computeCanonicalIntentId` in validate.ts hashes only
 * `s,r,a,f,t,n,ts`), so it is attacker-controlled. These tests pin the check
 * against the chain instead.
 *
 * The account is encoded with the SPL layout and served through a fake
 * `Connection`, so `getAccount` does its real decoding work. Hand-rolling the
 * bytes rather than mocking the decoder means a change in how spl-token reads an
 * account surfaces here instead of being mocked away — the price is 40 lines of
 * encoder, which is worth it for the one check standing between an intent and
 * someone else's balance.
 */

const MINT = Keypair.fromSeed(new Uint8Array(32).fill(1)).publicKey;
const SENDER = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
/** The key the relayer holds and signs with. */
const OURS = Keypair.fromSeed(new Uint8Array(32).fill(3)).publicKey;
/** A valid key that is not ours — a stale delegate, or someone else's. */
const THEIRS = Keypair.fromSeed(new Uint8Array(32).fill(4)).publicKey;

const SOURCE_ATA = getAssociatedTokenAddressSync(MINT, SENDER, false, TOKEN_PROGRAM_ID);

interface AccountFields {
  amount?: bigint;
  delegate?: PublicKey | null;
  delegatedAmount?: bigint;
  frozen?: boolean;
}

/** Encode a token account the way the SPL program stores it. */
function encodeAccount(fields: AccountFields = {}): Buffer {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  const delegate = fields.delegate === undefined ? OURS : fields.delegate;

  AccountLayout.encode(
    {
      mint: MINT,
      owner: SENDER,
      amount: fields.amount ?? 1_000_000_000n,
      delegateOption: delegate ? 1 : 0,
      delegate: delegate ?? PublicKey.default,
      delegatedAmount: fields.delegatedAmount ?? 1_000_000_000n,
      state: fields.frozen ? AccountState.Frozen : AccountState.Initialized,
      isNativeOption: 0,
      isNative: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

/**
 * A Connection that serves one token account and nothing else.
 *
 * `getAccountInfo` returning null is how spl-token learns an account does not
 * exist, so passing `null` exercises the real not-found path.
 */
function fakeConnection(data: Buffer | null): Connection {
  return {
    getAccountInfo: async () =>
      data === null
        ? null
        : {
          data,
          executable: false,
          lamports: 2_039_280,
          owner: TOKEN_PROGRAM_ID,
          rentEpoch: 0,
        },
  } as unknown as Connection;
}

function check(fields: AccountFields | null, amount = 1_000_000n) {
  return verifyDelegation(fakeConnection(fields === null ? null : encodeAccount(fields)), {
    sender: SENDER,
    mint: MINT,
    delegate: OURS,
    amount,
    tokenProgramId: TOKEN_PROGRAM_ID,
  });
}

// ─── the approval holds ───

test("accepts when the chain names us as delegate with enough allowance", async () => {
  const result = await check({});
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
  if (!result.ok) return;
  assert.equal(result.delegation.sourceAta.toBase58(), SOURCE_ATA.toBase58());
  assert.equal(result.delegation.delegatedAmount, 1_000_000_000n);
});

test("the source account is derived, never supplied by a caller", async () => {
  // A caller passing a token account where a wallet belongs is the confusion
  // this check exists to catch, so the ATA must come from (sender, mint) here.
  const result = await check({});
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.notEqual(result.delegation.sourceAta.toBase58(), SENDER.toBase58());
});

test("an allowance exactly equal to the debit is sufficient", async () => {
  // Boundary: SPL checks `delegated_amount >= amount`, so equality must pass.
  // An off-by-one here would refuse the last valid payment of every approval.
  const result = await check({ delegatedAmount: 1_000_000n }, 1_000_000n);
  assert.equal(result.ok, true, result.ok ? "" : result.failure.message);
});

// ─── the approval does not hold ───

test("REFUSES when the sender approved a different delegate", async () => {
  // The case `metadata.hw` cannot catch: the client may name us, but the chain
  // says someone else holds the approval.
  const result = await check({ delegate: THEIRS });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "DELEGATE_MISMATCH");
  assert.equal(result.failure.stage, RelayerFailureStage.Validation);
  assert.match(result.failure.message, new RegExp(THEIRS.toBase58()));
  assert.match(result.failure.message, new RegExp(OURS.toBase58()));
});

test("REFUSES when no delegate has been approved at all", async () => {
  // Distinct from a mismatch: the user has not completed onboarding, rather
  // than having approved the wrong account. Different remedy, different code.
  const result = await check({ delegate: null });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "NO_DELEGATE_APPROVAL");
});

test("REFUSES when the allowance is one base unit short", async () => {
  const result = await check({ delegatedAmount: 999_999n }, 1_000_000n);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "DELEGATION_EXHAUSTED");
  assert.match(result.failure.message, /decreasing budget/);
});

test("REFUSES a frozen account before looking at the delegation", async () => {
  // A frozen account cannot transfer no matter who is approved, so reporting an
  // allowance problem would send the operator chasing the wrong thing.
  const result = await check({ frozen: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "SOURCE_ACCOUNT_FROZEN");
});

test("REFUSES when the balance cannot cover the debit", async () => {
  // Separate from an exhausted allowance: this is fixed by funding the account,
  // not by re-approving. Conflating them sends the user to the wrong remedy.
  const result = await check({ amount: 500_000n, delegatedAmount: 10_000_000n }, 1_000_000n);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "INSUFFICIENT_BALANCE");
});

test("REFUSES when the token account does not exist", async () => {
  const result = await check(null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.failure.code, "SOURCE_ACCOUNT_UNREADABLE");
});

// ─── fees are part of the debit ───

test("the allowance must cover the fees too, not just the payment", async () => {
  // The reason `verifyDelegation` takes a total rather than the payment amount.
  // An approval covering 1.0 exactly, against a payment of 1.0 plus a 0.01 fee,
  // would pass a payment-only check and then fail partway through a
  // multi-instruction transaction — after the fee payer had already spent.
  const paymentOnly = 1_000_000n;
  const withFees = 1_010_000n;

  const wouldPass = await check({ delegatedAmount: paymentOnly }, paymentOnly);
  assert.equal(wouldPass.ok, true, "the payment alone fits the allowance");

  const result = await check({ delegatedAmount: paymentOnly }, withFees);
  assert.equal(result.ok, false, "but payment + fees does not, and must be refused");
  if (result.ok) return;
  assert.equal(result.failure.code, "DELEGATION_EXHAUSTED");
});

// ─── every refusal is terminal ───

test("no refusal is retriable — none of these change without the user acting", async () => {
  // Retrying a missing approval burns every attempt against a fixed state and
  // delays the failure the user needs to see.
  const cases = [
    await check({ delegate: THEIRS }),
    await check({ delegate: null }),
    await check({ delegatedAmount: 1n }, 1_000_000n),
    await check({ frozen: true }),
    await check({ amount: 1n }, 1_000_000n),
    await check(null),
  ];

  for (const result of cases) {
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(
      result.failure.retriable,
      false,
      `${result.failure.code} should not be retriable`,
    );
  }
});
