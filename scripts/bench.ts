/**
 * ZRN benchmark: submit N intents to the relayer and measure time-to-settled
 * and success rate.
 *
 * ── What this script used to do ──
 *
 * It POSTed `{ transaction: <base64 tx> }` to `/v1/transactions` with an
 * `x-relayer-api-key` header. None of those three things exist:
 *
 *   - The only submit endpoint is `POST /v1/intents` (src/api/routes.ts).
 *     `/v1/transactions/:jobId` is a *read*; there is no POST at that path, so
 *     every submission was a 404 measured very precisely.
 *   - The auth header is `x-api-key`.
 *   - The relayer does not accept a serialized transaction at all. It takes a
 *     signed *intent* and builds the transaction itself, which is the whole
 *     point of the model — the user is offline and cannot fetch a blockhash.
 *
 * So this now speaks the legacy intent-bundle format that `validateIntent`
 * actually parses, and needs no RPC connection: nothing here builds a
 * transaction any more.
 *
 * ── Required env ──
 *
 *   RELAYER_API_KEY         a `zypp_...` key from the console. Not the same
 *                           thing as the old shared secret of the same name —
 *                           the server hashes this and looks it up in api_keys.
 *   RELAYER_INTENT_DOMAIN   must match the server's value exactly. A mismatch
 *                           is not a config warning, it is INVALID_SIGNATURE on
 *                           every intent, because the domain is inside the
 *                           bytes that get signed.
 *
 * Optional: API_URL, BENCH_N, BENCH_RECEIVER, BENCH_NETWORK,
 * KEYPAIR_PATH / KEYPAIR_BASE58.
 */
import "dotenv/config";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const N = parseInt(process.env.BENCH_N ?? "10", 10);
const API_KEY = process.env.RELAYER_API_KEY ?? "";
const INTENT_DOMAIN = process.env.RELAYER_INTENT_DOMAIN ?? "";
const NETWORK = process.env.BENCH_NETWORK === "mainnet-beta" ? "mainnet-beta" : "devnet";

/**
 * Every status a job can stop at — not just the two happy-ish ones.
 *
 * `shunted` and `acknowledged` are terminal too (src/lib/constants.ts). Polling
 * only for confirmed/failed reports them as timeouts, which reads as "the
 * relayer hung" when in fact it decided.
 */
const TERMINAL = new Set(["confirmed", "failed", "shunted", "acknowledged"]);

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
  console.warn(
    "No KEYPAIR_PATH or KEYPAIR_BASE58; using an ephemeral sender. Intents will be " +
      "accepted and queued, but settlement will fail at broadcast — the account holds nothing.",
  );
  return k;
}

/**
 * Mirrors `computeCanonicalIntentId` in src/lib/validate.ts.
 *
 * The key names and their order are load-bearing: the server recomputes this
 * hash from the fields it received and rejects the intent if it differs, which
 * is what stops a client relabelling an intent after signing it. Change one
 * character here and every submission comes back INVALID_INTENT_ID.
 */
function canonicalIntentId(i: {
  sender: string;
  receiver: string;
  amount: number;
  fee: number;
  total: number;
  nonce: string;
  timestamp: number;
}): string {
  const canonicalBody = JSON.stringify({
    s: i.sender,
    r: i.receiver,
    a: i.amount,
    f: i.fee,
    t: i.total,
    n: i.nonce,
    ts: i.timestamp,
  });
  return createHash("sha256").update(canonicalBody).digest("hex");
}

/** Domain-separated, exactly as validateIntent verifies it. */
function signIntentId(intentId: string, signer: Keypair): string {
  const message = createHash("sha256").update(`${INTENT_DOMAIN}:${intentId}`).digest();
  return Buffer.from(nacl.sign.detached(message, signer.secretKey)).toString("base64");
}

function buildIntentBundle(signer: Keypair, receiver: string, runId: string, i: number) {
  // Small and exact. USDC values are checked to at most 6 decimal places, and
  // total must equal amount + fee to within 1e-9.
  const amount = 0.01;
  const fee = 0.001;
  const total = Number((amount + fee).toFixed(6));

  const base = {
    sender: signer.publicKey.toBase58(),
    receiver,
    amount,
    fee,
    total,
    // Unique per run as well as per iteration: (sender, nonce) is the replay
    // namespace, so reusing a nonce across two runs is a 409, not a data point.
    nonce: `bench-${runId}-${i}`,
    timestamp: Date.now(),
  };

  const id = canonicalIntentId(base);

  // The schema is strict — an extra key here is a 400, not a warning.
  return {
    intent: {
      id,
      ...base,
      signature: signIntentId(id, signer),
      metadata: {
        v: 1 as const,
        app: "zypp-pay" as const,
        network: NETWORK,
        chain: "solana" as const,
        hw: "zrn-bench",
      },
    },
  };
}

async function submitIntent(bundle: unknown): Promise<{ jobId: string; status: string }> {
  const payload = Buffer.from(JSON.stringify(bundle)).toString("base64");
  const res = await fetch(`${API_URL}/v1/intents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
    },
    body: JSON.stringify({ payload }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /v1/intents failed ${res.status}: ${text}`);
  }
  return (await res.json()) as { jobId: string; status: string };
}

async function pollStatus(jobId: string): Promise<JobResult> {
  const start = Date.now();
  const maxWait = 120_000;
  while (Date.now() - start < maxWait) {
    const res = await fetch(`${API_URL}/v1/intents/${jobId}`, {
      headers: {
        "x-api-key": API_KEY,
      },
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
    if (TERMINAL.has(data.status)) {
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

/** Nearest-rank, clamped. `latencies[len]` is undefined at q=1 and small n. */
function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function main() {
  // Fail here rather than N times against the server. A missing domain in
  // particular surfaces as INVALID_SIGNATURE, which looks like a key problem.
  const missing = [
    !API_KEY && "RELAYER_API_KEY",
    !INTENT_DOMAIN && "RELAYER_INTENT_DOMAIN",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`Missing required env: ${missing.join(", ")}`);
    process.exit(1);
  }

  const signer = await getKeypair();

  const receiverEnv = process.env.BENCH_RECEIVER;
  let receiver: string;
  if (receiverEnv) {
    try {
      receiver = new PublicKey(receiverEnv).toBase58();
    } catch {
      console.error(`BENCH_RECEIVER is not a valid Solana public key: ${receiverEnv}`);
      process.exit(1);
    }
  } else {
    receiver = Keypair.generate().publicKey.toBase58();
  }

  const runId = randomUUID().slice(0, 8);

  console.log("ZRN benchmark");
  console.log("  API_URL:", API_URL);
  console.log("  Network:", NETWORK);
  console.log("  N:", N);
  console.log("  Run:", runId);
  console.log("  Sender:", signer.publicKey.toBase58());
  console.log("  Receiver:", receiver);

  const results: JobResult[] = [];

  for (let i = 0; i < N; i++) {
    const bundle = buildIntentBundle(signer, receiver, runId, i);
    const { jobId } = await submitIntent(bundle);
    results.push(await pollStatus(jobId));
  }

  const by = (s: string) => results.filter((r) => r.status === s);
  const confirmed = by("confirmed");
  const latencies = confirmed
    .map((r) => r.latencyMs!)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);

  console.log("\n--- Results ---");
  console.log("  Confirmed:", confirmed.length);
  console.log("  Failed:", by("failed").length);
  console.log("  Shunted:", by("shunted").length);
  console.log("  Acknowledged:", by("acknowledged").length);
  console.log("  Timeout:", by("timeout").length);
  console.log("  Success rate:", `${((confirmed.length / N) * 100).toFixed(1)}%`);
  if (latencies.length) {
    console.log(
      "  Latency (ms) - p50:",
      percentile(latencies, 0.5),
      "p95:",
      percentile(latencies, 0.95),
      "p99:",
      percentile(latencies, 0.99),
    );
  }

  const firstError = results.find((r) => r.error)?.error;
  if (firstError) console.log("  First error:", firstError);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
