import { Connection, PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";

/**
 * On-chain mint decimals, resolved once and cached forever.
 *
 * ## Why this exists
 *
 * Decimals used to be a hardcoded ternary — `USDC ? 6 : WSOL ? 9 : 0` — which
 * worked only because exactly two mints were supported. Two things make that
 * untenable:
 *
 * 1. `createTransferCheckedInstruction` takes a **decimals operand**. The
 *    relayer cannot construct a transfer for a mint whose decimals it does not
 *    know, so open token support is hard-blocked on this lookup.
 * 2. The fallback branch returned `0`, which is not "unknown" — it is a
 *    truthful-looking claim that the token is indivisible. Any amount formatted
 *    under it reads as a whole-token figure when it is really base units.
 *
 * ## Caching is safe, and unusually so
 *
 * A mint's `decimals` is fixed at initialisation and there is no SPL
 * instruction that alters it. Unlike a balance or an authority, this value
 * cannot go stale — so the cache needs no TTL and no invalidation. That is a
 * property of the token program, not an assumption about usage.
 *
 * Negative results are **not** cached. A failed lookup usually means a
 * transient RPC problem, and caching that would turn a blip into a persistent
 * refusal for that mint.
 */

/** What the relayer needs to know about a mint in order to move it. */
export interface MintInfo {
  /** Decimal places. Required operand for TransferChecked. */
  decimals: number;
  /** Owning token program — plain SPL Token or Token-2022. */
  programId: PublicKey;
}

/** Canonical SPL Token program. */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
/** Token-2022. */
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/**
 * Raised when a mint's decimals cannot be established.
 *
 * Distinct from a policy refusal: this is "we could not learn what we needed",
 * not "we learned it and said no". Callers must refuse the transaction either
 * way — constructing a transfer with guessed decimals would move the wrong
 * amount by a factor of ten to some power.
 */
export class MintResolutionError extends Error {
  constructor(
    readonly mint: string,
    reason: string,
  ) {
    super(`Could not resolve mint ${mint}: ${reason}`);
    this.name = "MintResolutionError";
  }
}

/**
 * Decimals cache, keyed by mint address.
 *
 * Module-scoped rather than injected because the value is immutable and
 * process-global — two callers resolving the same mint must get the same
 * answer, and there is no scenario where separate instances should disagree.
 */
const cache = new Map<string, MintInfo>();

/**
 * In-flight lookups, so N concurrent broadcasts of the same mint issue one RPC
 * call rather than N. The worker runs at `BULL_CONCURRENCY`, and a queue flush
 * after downtime will contain many intents for the same token.
 */
const inFlight = new Map<string, Promise<MintInfo>>();

/**
 * Resolve a mint's decimals and owning program.
 *
 * Tries plain SPL Token first, then Token-2022. The two programs own disjoint
 * sets of mints and `getMint` rejects a mint owned by the other program, so
 * attempting both is how the owner is discovered — there is no cheaper way
 * short of a raw `getAccountInfo` and reading the owner field.
 *
 * @throws {MintResolutionError} when neither program recognises the mint, or
 * the RPC is unreachable
 */
export async function resolveMint(
  connection: Connection,
  mint: PublicKey,
): Promise<MintInfo> {
  const key = mint.toBase58();

  const cached = cache.get(key);
  if (cached) return cached;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const lookup = (async (): Promise<MintInfo> => {
    const failures: string[] = [];

    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const info = await getMint(connection, mint, undefined, programId);
        const resolved: MintInfo = { decimals: info.decimals, programId };
        cache.set(key, resolved);
        return resolved;
      } catch (e) {
        failures.push(
          `${programId.equals(TOKEN_PROGRAM_ID) ? "Token" : "Token-2022"}: ` +
            (e instanceof Error ? e.message : String(e)),
        );
      }
    }

    // Deliberately not cached — see the header note on negative results.
    throw new MintResolutionError(key, failures.join("; "));
  })();

  inFlight.set(key, lookup);
  try {
    return await lookup;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Seed the cache without an RPC call.
 *
 * For tests, and for mints whose decimals are known statically. Using this in
 * production for a mint you have not verified defeats the point of the lookup.
 */
export function primeMintCache(mint: string, info: MintInfo): void {
  cache.set(mint, info);
}

/** Cached decimals, or null if this mint has not been resolved yet. */
export function cachedDecimals(mint: string): number | null {
  return cache.get(mint)?.decimals ?? null;
}

/** Clear the cache. Test isolation only — production has no reason to. */
export function clearMintCache(): void {
  cache.clear();
  inFlight.clear();
}
