/**
 * ZRN benchmark: submit N transactions to the API and measure time-to-confirmed and success rate.
 * Uses devnet. Set API_URL (ZRN API base URL), N (count), and optionally KEYPAIR_PATH or KEYPAIR_BASE58.
 */
import "dotenv/config";
import { Connection, Keypair, Transaction, PublicKey, TransactionInstruction } from "@solana/web3.js";
import * as fs from "node:fs";
import * as path from "node:path";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const N = parseInt(process.env.BENCH_N ?? "10", 10);
const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";

interface JobResult {
  jobId: string;
  status: string;
  createdAt?: string;
  confirmedAt?: string;
  latencyMs?: number;
  error?: string;
}

async function getKeypair(): Promise<Keypair> {
  const pathEnv = process.env.KEYPAIR_PATH;
  const base58Env = process.env.KEYPAIR_BASE58;
  if (pathEnv) {
    const keypairPath = path.resolve(pathEnv);
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  if (base58Env) {
    const bs58 = await import("bs58");
    return Keypair.fromSecretKey(bs58.default.decode(base58Env));
  }
  const k = Keypair.generate();
  console.warn("No KEYPAIR_PATH or KEYPAIR_BASE58; using ephemeral keypair (devnet faucet required)");
  return k;
}

async function createSignedTx(connection: Connection, signer: Keypair, nonce: number): Promise<Buffer> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.add(new TransactionInstruction({ keys: [], programId: new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"), data: Buffer.from(`zrn-bench-${nonce}-${Date.now()}`) }));
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  tx.sign(signer);
  return tx.serialize();
}

async function submitTx(payloadBase64: string): Promise<{ jobId: string; status: string }> {
  const res = await fetch(`${API_URL}/v1/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-relayer-api-key": process.env.RELAYER_API_KEY || ""
    },
    body: JSON.stringify({ transaction: payloadBase64 }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST failed ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { jobId: string; status: string };
  return data;
}

async function pollStatus(jobId: string): Promise<JobResult> {
  const start = Date.now();
  const maxWait = 120_000;
  while (Date.now() - start < maxWait) {
    const res = await fetch(`${API_URL}/v1/transactions/${jobId}`, {
      headers: {
        "x-relayer-api-key": process.env.RELAYER_API_KEY || ""
      }
    });
    if (!res.ok) throw new Error(`GET failed ${res.status}`);
    const data = (await res.json()) as {
      jobId: string;
      status: string;
      createdAt: string;
      updatedAt: string;
      txSignature?: string;
      lastError?: string;
    };
    if (data.status === "confirmed" || data.status === "failed") {
      return {
        jobId: data.jobId,
        status: data.status,
        createdAt: data.createdAt,
        confirmedAt: data.updatedAt,
        latencyMs: new Date(data.updatedAt).getTime() - new Date(data.createdAt).getTime(),
        error: data.lastError,
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { jobId, status: "timeout" };
}

async function main() {
  console.log("ZRN benchmark");
  console.log("  API_URL:", API_URL);
  console.log("  RPC_URL:", RPC_URL);
  console.log("  N:", N);

  const connection = new Connection(RPC_URL);
  const signer = await getKeypair();
  console.log("  Signer:", signer.publicKey.toBase58());

  const results: JobResult[] = [];

  for (let i = 0; i < N; i++) {
    const txBuffer = await createSignedTx(connection, signer, i);
    const base64 = txBuffer.toString("base64");
    const { jobId } = await submitTx(base64);
    results.push(await pollStatus(jobId));
  }

  const confirmed = results.filter((r) => r.status === "confirmed");
  const failed = results.filter((r) => r.status === "failed");
  const timeouts = results.filter((r) => r.status === "timeout");
  const latencies = confirmed.map((r) => r.latencyMs!).filter(Boolean).sort((a, b) => a - b);

  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? null;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? null;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] ?? null;

  console.log("\n--- Results ---");
  console.log("  Confirmed:", confirmed.length);
  console.log("  Failed:", failed.length);
  console.log("  Timeout:", timeouts.length);
  console.log("  Success rate:", `${((confirmed.length / N) * 100).toFixed(1)}%`);
  if (latencies.length) {
    console.log("  Latency (ms) - p50:", p50, "p95:", p95, "p99:", p99);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
