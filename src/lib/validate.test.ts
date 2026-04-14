import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createHash } from "node:crypto";
import { parseIntentPayload, validateIntent } from "./validate.js";

const log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as any;

const INTENT_DOMAIN = "zypp-pay:v1:intent";

function hashHex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function signIntentId(id: string, kp: Keypair): string {
  const digest = createHash("sha256").update(`${INTENT_DOMAIN}:${id}`).digest();
  const signature = nacl.sign.detached(new Uint8Array(digest), kp.secretKey);
  return Buffer.from(signature).toString("base64");
}

async function buildTransferPayload() {
  const kp = Keypair.generate();
  const intent = {
    sender: kp.publicKey.toBase58(),
    receiver: Keypair.generate().publicKey.toBase58(),
    amount: 2,
    fee: 0.01,
    total: 2.01,
    nonce: "1710000000-abcd1234abcd1234",
    timestamp: Date.now(),
    type: "TRANSFER",
    metadata: {
      v: 1 as const,
      app: "zypp-pay" as const,
      network: "devnet" as const,
      chain: "solana" as const,
      hw: Keypair.generate().publicKey.toBase58(),
    },
  };
  const id = hashHex(
    JSON.stringify({
      s: intent.sender,
      r: intent.receiver,
      a: intent.amount,
      f: intent.fee,
      t: intent.total,
      n: intent.nonce,
      ts: intent.timestamp,
    })
  );
  const signature = signIntentId(id, kp);
  const payload = Buffer.from(
    JSON.stringify({
      intent: { ...intent, id, signature },
    })
  ).toString("base64");
  return payload;
}

test("validateIntent accepts canonical zypp transfer intent", async () => {
  const payload = await buildTransferPayload();
  const result = await validateIntent(payload, log, INTENT_DOMAIN);
  assert.equal(result.ok, true);
});

test("parseIntentPayload rejects missing metadata contract", async () => {
  const kp = Keypair.generate();
  const intent = {
    id: hashHex("x"),
    sender: kp.publicKey.toBase58(),
    receiver: Keypair.generate().publicKey.toBase58(),
    amount: 1,
    fee: 0.01,
    total: 1.01,
    nonce: "n-1",
    timestamp: Date.now(),
    signature: signIntentId(hashHex("x"), kp),
  };
  const result = parseIntentPayload(Buffer.from(JSON.stringify({ intent })));
  assert.equal(result.ok, false);
});
