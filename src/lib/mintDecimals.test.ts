import test from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import {
  resolveMint,
  primeMintCache,
  cachedDecimals,
  clearMintCache,
  MintResolutionError,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./mintDecimals.js";

/**
 * On-chain decimals resolution.
 *
 * Construction is hard-blocked on this: `createTransferCheckedInstruction`
 * takes a decimals operand, so a mint whose decimals are unknown cannot be
 * moved. The tests that matter most are the ones asserting a *failure* to
 * resolve refuses rather than guesses — a wrong decimals value moves the wrong
 * amount by a power of ten.
 */

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const SOME_2022_MINT = new PublicKey("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");

/**
 * Minimal Connection double.
 *
 * `getMint` calls `getAccountInfo` and parses the returned buffer, so the fake
 * returns a real 82-byte mint layout. Only the fields getMint validates matter:
 * the owner must equal the program being queried, and byte 44 holds decimals.
 */
function fakeConnection(opts: {
  /** Mints that exist, by address, with their owning program and decimals. */
  mints?: Record<string, { programId: PublicKey; decimals: number }>;
  /** Throw on every call, simulating an unreachable RPC. */
  unreachable?: boolean;
  /** Records each getAccountInfo call for assertions about caching. */
  calls?: string[];
}) {
  return {
    async getAccountInfo(address: PublicKey) {
      opts.calls?.push(address.toBase58());
      if (opts.unreachable) throw new Error("failed to get info about account");

      const entry = opts.mints?.[address.toBase58()];
      if (!entry) return null;

      // SPL Mint layout is 82 bytes. decimals sits at offset 44, and byte 45 is
      // the isInitialized flag — getMint rejects an uninitialised mint.
      const data = Buffer.alloc(82);
      data[44] = entry.decimals;
      data[45] = 1;

      return {
        owner: entry.programId,
        data,
        executable: false,
        lamports: 1_000_000,
        rentEpoch: 0,
      };
    },
  } as never;
}

test("resolves decimals for a plain SPL Token mint", async (t) => {
  t.after(clearMintCache);
  clearMintCache();

  const connection = fakeConnection({
    mints: { [USDC.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 6 } },
  });

  const info = await resolveMint(connection, USDC);
  assert.equal(info.decimals, 6);
  assert.ok(info.programId.equals(TOKEN_PROGRAM_ID));
});

test("resolves a Token-2022 mint by falling through to the second program", async (t) => {
  t.after(clearMintCache);
  clearMintCache();

  // getMint rejects a mint owned by a program other than the one queried, so
  // discovering the owner means trying both. This mint only answers for 2022.
  const connection = fakeConnection({
    mints: {
      [SOME_2022_MINT.toBase58()]: { programId: TOKEN_2022_PROGRAM_ID, decimals: 9 },
    },
  });

  const info = await resolveMint(connection, SOME_2022_MINT);
  assert.equal(info.decimals, 9);
  assert.ok(info.programId.equals(TOKEN_2022_PROGRAM_ID), "must report Token-2022 as the owner");
});

test("caches a resolved mint — a second call issues no RPC", async (t) => {
  t.after(clearMintCache);
  clearMintCache();

  const calls: string[] = [];
  const connection = fakeConnection({
    mints: { [USDC.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 6 } },
    calls,
  });

  await resolveMint(connection, USDC);
  const callsAfterFirst = calls.length;
  await resolveMint(connection, USDC);

  assert.equal(calls.length, callsAfterFirst, "the second resolve must be served from cache");
});

test("concurrent resolves of the same mint share one lookup", async (t) => {
  // A queue flush after downtime contains many intents for the same token, and
  // the worker runs several concurrently. Without in-flight coalescing each one
  // would issue its own RPC call for an immutable value.
  t.after(clearMintCache);
  clearMintCache();

  const calls: string[] = [];
  const connection = fakeConnection({
    mints: { [USDC.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 6 } },
    calls,
  });

  const results = await Promise.all([
    resolveMint(connection, USDC),
    resolveMint(connection, USDC),
    resolveMint(connection, USDC),
    resolveMint(connection, USDC),
  ]);

  assert.equal(calls.length, 1, "four concurrent resolves should make one RPC call");
  for (const r of results) assert.equal(r.decimals, 6);
});

test("REFUSES a mint neither program recognises", async (t) => {
  t.after(clearMintCache);
  clearMintCache();

  const connection = fakeConnection({ mints: {} });

  await assert.rejects(
    () => resolveMint(connection, SOME_2022_MINT),
    (err: unknown) => {
      assert.ok(err instanceof MintResolutionError);
      assert.equal(err.mint, SOME_2022_MINT.toBase58());
      // Both attempts must be reported, or diagnosing this is guesswork.
      assert.match(err.message, /Token:/);
      assert.match(err.message, /Token-2022:/);
      return true;
    },
  );
});

test("REFUSES when the RPC is unreachable rather than assuming decimals", async (t) => {
  // The critical property. Guessing here would construct a transfer moving the
  // wrong amount by a power of ten.
  t.after(clearMintCache);
  clearMintCache();

  const connection = fakeConnection({ unreachable: true });

  await assert.rejects(
    () => resolveMint(connection, USDC),
    (err: unknown) => {
      assert.ok(err instanceof MintResolutionError);
      return true;
    },
  );
});

test("does NOT cache a failure — a transient RPC error must not persist", async (t) => {
  // Caching a negative result would turn one bad RPC moment into a permanent
  // refusal for that mint, for the lifetime of the process.
  t.after(clearMintCache);
  clearMintCache();

  const broken = fakeConnection({ unreachable: true });
  await assert.rejects(() => resolveMint(broken, USDC));

  assert.equal(cachedDecimals(USDC.toBase58()), null, "the failure must not be cached");

  // The same mint resolves once the RPC recovers.
  const working = fakeConnection({
    mints: { [USDC.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 6 } },
  });
  const info = await resolveMint(working, USDC);
  assert.equal(info.decimals, 6);
});

test("a resolved mint is not re-resolved after a later RPC failure", async (t) => {
  // Decimals are immutable, so once known the value stays usable even if the
  // RPC later becomes unreachable. This is why the cache needs no TTL.
  t.after(clearMintCache);
  clearMintCache();

  const working = fakeConnection({
    mints: { [USDC.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 6 } },
  });
  await resolveMint(working, USDC);

  const broken = fakeConnection({ unreachable: true });
  const info = await resolveMint(broken, USDC);
  assert.equal(info.decimals, 6, "the cached value survives an RPC outage");
});

test("primeMintCache seeds a value without an RPC call", async (t) => {
  t.after(clearMintCache);
  clearMintCache();

  primeMintCache(USDC.toBase58(), { decimals: 6, programId: TOKEN_PROGRAM_ID });

  const calls: string[] = [];
  const connection = fakeConnection({ mints: {}, calls });
  const info = await resolveMint(connection, USDC);

  assert.equal(info.decimals, 6);
  assert.equal(calls.length, 0, "a primed mint should not be fetched");
});

test("zero decimals is a real answer, distinct from unknown", async (t) => {
  // An NFT or a whole-unit token genuinely has 0 decimals. That must resolve
  // successfully rather than being conflated with "could not determine".
  t.after(clearMintCache);
  clearMintCache();

  const connection = fakeConnection({
    mints: { [SOME_2022_MINT.toBase58()]: { programId: TOKEN_PROGRAM_ID, decimals: 0 } },
  });

  const info = await resolveMint(connection, SOME_2022_MINT);
  assert.equal(info.decimals, 0);
  assert.equal(cachedDecimals(SOME_2022_MINT.toBase58()), 0);
});

test("cachedDecimals reports null for an unresolved mint", () => {
  clearMintCache();
  assert.equal(cachedDecimals(USDC.toBase58()), null);
});
