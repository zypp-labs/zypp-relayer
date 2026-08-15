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
import { processIntentAndBroadcast } from "./broadcast.js";
import { type IntentEnvelope } from "../lib/feePayer.js";
import { InMemoryVelocityStore, type VelocityStore } from "../lib/spendPolicy.js";
import type { AlertNotifier, CircuitBreakerAlert } from "../lib/alerting.js";

/**
 * Integration of the spend breakers into the broadcast path.
 *
 * The unit suites cover the guards in isolation; these prove the wiring — that
 * a transaction crossing a ceiling is refused *before* co-signing, that the
 * refusal carries the PolicyCheck failure, and that the alert fires.
 */

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as never;

const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
const USER = Keypair.fromSeed(new Uint8Array(32).fill(42));
const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(7));

const config = {
  FEE_PAYER_SECRET_KEY: JSON.stringify(Array.from(FEE_PAYER.secretKey)),
  FEE_PAYER_LEGACY_SECRET_KEYS: undefined,
  RPC_URLS: ["https://api.devnet.solana.com"],
  RPC_CONFIRMATION_COMMITMENT: "confirmed",
  RPC_CONFIRMATION_TIMEOUT_MS: 1000,
} as never;

/** A real user-signed TransferChecked of `amount` base units to `recipient`. */
function signedTransfer(amount: bigint, recipient: Keypair): Buffer {
  const source = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey;
  const [destAta] = PublicKey.findProgramAddressSync(
    [recipient.publicKey.toBytes(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBytes(), MINT.toBytes()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  );

  // TransferChecked (discriminator 12) so the mint is an instruction operand —
  // a bare Transfer has no mint, so the policy cannot determine the asset and
  // correctly fails closed with NO_CEILING_CONFIGURED. These tests need the
  // mint present to exercise the amount-ceiling comparison.
  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK",
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        keys: [
          { pubkey: source, isSigner: false, isWritable: true },
          { pubkey: MINT, isSigner: false, isWritable: false },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: USER.publicKey, isSigner: true, isWritable: false },
        ],
        data: (() => {
          // [discriminator=12][amount u64le][decimals u8]
          const d = Buffer.alloc(10);
          d[0] = 12;
          d.writeBigUInt64LE(amount, 1);
          d[9] = 6;
          return d;
        })(),
      }),
    ],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), USER.secretKey);
  return Buffer.from(tx.serialize());
}

const envelope: IntentEnvelope = {
  version: 1,
  network: "solana",
  intent: "payment",
  payload: {},
  signature: { publicKey: USER.publicKey.toBase58(), signature: "x", nonce: 1 },
};

function policyCtx(jobId: string, teamId: string, velocityStore: VelocityStore, alerts: CircuitBreakerAlert[]) {
  const notifier: AlertNotifier = {
    async notify(a) {
      alerts.push(a);
    },
  };
  return { jobId, teamId, velocityStore, notifier };
}

// ─── Clearance ───
//
// A cleared transaction falls through to a real broadcast, which would hit the
// network. These tests therefore assert only the negative — that the *policy*
// did not refuse it — and use an RPC list pointed at an unroutable address so
// the attempt fails fast instead of hanging.

const offlineConfig = {
  ...(config as Record<string, unknown>),
  RPC_URLS: ["http://127.0.0.1:1"],
  RPC_CONFIRMATION_TIMEOUT_MS: 50,
} as never;

test("a payment inside every limit is not refused by policy", async () => {
  const alerts: CircuitBreakerAlert[] = [];
  const result = await processIntentAndBroadcast(
    signedTransfer(1_000_000n, USER), // 1 USDC, far under the $100 ceiling
    envelope,
    offlineConfig,
    silentLog,
    policyCtx("job-clear", "team-clear", new InMemoryVelocityStore(), alerts),
  );

  // The broadcast will fail (no network), but the reason must not be policy.
  assert.equal(result.success, false);
  if (result.success) return;
  assert.notEqual(result.failure?.stage, "PolicyCheck", "policy must clear a normal payment");
  assert.equal(alerts.length, 0, "no alert may fire for a cleared payment");
});

test("a payment just under the ceiling still clears", async () => {
  // $99.99 — the boundary case that must not be caught.
  const alerts: CircuitBreakerAlert[] = [];
  const result = await processIntentAndBroadcast(
    signedTransfer(99_990_000n, USER),
    envelope,
    offlineConfig,
    silentLog,
    policyCtx("job-boundary", "team-boundary", new InMemoryVelocityStore(), alerts),
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.notEqual(result.failure?.stage, "PolicyCheck");
  assert.equal(alerts.length, 0);
});

test("an amount over the ceiling is refused before co-signing", async () => {
  const alerts: CircuitBreakerAlert[] = [];
  const result = await processIntentAndBroadcast(
    signedTransfer(500_000_000n, USER), // 500 USDC
    envelope,
    config,
    silentLog,
    policyCtx("job-over", "team-over", new InMemoryVelocityStore(), alerts),
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.failure?.code, "AMOUNT_EXCEEDS_CEILING");
  assert.equal(result.failure?.retriable, false);
  assert.equal(result.failure?.stage, "PolicyCheck");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].amount, 500_000_000n);
  assert.equal(alerts[0].threshold, 100_000_000n);
  assert.equal(alerts[0].code, "AMOUNT_EXCEEDS_CEILING");
});

test("the alert carries the intent id and team id", async () => {
  const alerts: CircuitBreakerAlert[] = [];
  await processIntentAndBroadcast(
    signedTransfer(500_000_000n, USER),
    envelope,
    config,
    silentLog,
    policyCtx("job-abc", "team-xyz", new InMemoryVelocityStore(), alerts),
  );
  assert.equal(alerts[0].intentId, "job-abc");
  assert.equal(alerts[0].teamId, "team-xyz");
});

test("an asset with no configured ceiling is refused (fail-closed)", async () => {
  // A bare Transfer with an unlisted mint.
  const otherMint = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL
  const otherSource = Keypair.fromSeed(new Uint8Array(32).fill(21)).publicKey;
  const otherRecipient = Keypair.fromSeed(new Uint8Array(32).fill(23)).publicKey;
  const [destAta] = PublicKey.findProgramAddressSync(
    [otherRecipient.toBytes(), new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").toBytes(), otherMint.toBytes()],
    new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
  );
  const message = new TransactionMessage({
    payerKey: FEE_PAYER.publicKey,
    recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DUNYtBRUXNJKUpKBAWK",
    instructions: [
      new TransactionInstruction({
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        keys: [
          { pubkey: otherSource, isSigner: false, isWritable: true },
          { pubkey: destAta, isSigner: false, isWritable: true },
          { pubkey: USER.publicKey, isSigner: true, isWritable: false },
        ],
        data: (() => {
          const d = Buffer.alloc(9);
          d[0] = 3;
          d.writeBigUInt64LE(1n, 1);
          return d;
        })(),
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.signatures[0] = nacl.sign.detached(tx.message.serialize(), USER.secretKey);

  const alerts: CircuitBreakerAlert[] = [];
  const result = await processIntentAndBroadcast(
    Buffer.from(tx.serialize()),
    envelope,
    config,
    silentLog,
    policyCtx("job-unknown-mint", "team-unknown", new InMemoryVelocityStore(), alerts),
  );
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.failure?.code, "NO_CEILING_CONFIGURED");
  assert.equal(alerts.length, 1);
});
