import { randomUUID } from "node:crypto";
import type { BroadcastRecord, VelocityStore } from "./spendPolicy.js";

/**
 * Redis-backed velocity store with per-team and global windows.
 *
 * `InMemoryVelocityStore` keeps the rolling window in process memory, which
 * makes the circuit breaker trivially bypassable: the worker is not guaranteed
 * to be long-lived — hosts restart on deploy, on scaling, and (on plans with
 * idle suspension) on the first request after a quiet period. The window resets
 * with each of those. Anyone able to trigger a restart could clear the breaker
 * on demand, and even without an adversary a routine deploy silently forgets
 * everything the fee payer has spent.
 *
 * Redis is already present for BullMQ, so the durable window costs no new
 * infrastructure.
 *
 * ## Representation
 *
 * One sorted set per team (`zrn:fee-payer:velocity:team:<teamId>`), plus one
 * global aggregate (`zrn:fee-payer:velocity:global`). Score is the broadcast
 * timestamp (ms), so a window query is a range scan. The member carries both
 * the asset and the value: `"<asset>|<value>|<uuid>"`.
 *
 * The asset is part of the member because value caps are per-mint — base units
 * are not comparable across assets, so a window has to report each mint's total
 * separately rather than one sum. The uuid is load-bearing for a different
 * reason: sorted-set members are unique, so two broadcasts of the same asset and
 * amount at the same instant would collapse into one entry and undercount the
 * spend.
 *
 * `|` is the separator because base58 mint addresses and decimal values never
 * contain it, so splitting is unambiguous.
 *
 * Values are summed as `bigint` in Node rather than in Redis. Lua numbers are
 * IEEE doubles and lose integer precision above 2^53, which for an 18-decimal
 * token is only ~9 whole units — not a safe basis for a spend limit.
 *
 * ## Per-team scoping
 *
 * Without per-team windows, the platform-wide count cap is a shared budget
 * consumed by whichever tenant arrives first — one team's burst halts broadcasts
 * for every other team, an availability leak with the same tenant-isolation
 * shape as a cross-tenant data leak.
 *
 * With per-team windows each tenant has their own allowance, and both the global
 * and per-team caps are checked. A halt names which scope tripped and for which
 * team, so the operator knows whether it's one misbehaving tenant or a
 * platform-wide condition.
 */

/** The Redis surface this store needs. Narrow so tests can fake it. */
export interface RedisLike {
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zrangebyscore(key: string, min: number | string, max: number | string): Promise<string[]>;
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

const KEY_PREFIX = "zrn:fee-payer:velocity";

/**
 * Global key, aggregating spend across every team.
 */
function globalKey(prefix: string): string {
  return `${prefix}:global`;
}

/**
 * Per-team key.
 *
 * The team id is a UUID from our own database, not caller-supplied text, so it
 * cannot inject a separator or collide with the global key's namespace.
 */
function teamKey(prefix: string, teamId: string): string {
  return `${prefix}:team:${teamId}`;
}

/** Entries older than this are pruned on write. Must exceed the longest window. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Key TTL, refreshed on every write. Bounds the damage if the relayer stops
 * permanently — the set expires rather than lingering forever.
 */
const KEY_TTL_MS = 2 * RETENTION_MS;

/**
 * Total value per asset across sorted-set members.
 *
 * A malformed member is skipped rather than throwing. Refusing to compute the
 * window because one entry is corrupt would trip the fail-closed path and halt
 * all broadcasts — a worse outcome than undercounting by one entry. Exported
 * for direct testing.
 */
export function sumVelocityMembers(members: string[]): Map<string, bigint> {
  const totals = new Map<string, bigint>();

  for (const member of members) {
    const parts = member.split("|");
    // Expected shape is `<asset>|<value>|<uuid>`. Anything else is corrupt.
    if (parts.length < 2) continue;

    const [asset, rawValue] = parts;
    try {
      const value = BigInt(rawValue);
      totals.set(asset, (totals.get(asset) ?? 0n) + value);
    } catch {
      // Not a parseable value — skip it.
    }
  }

  return totals;
}

export class RedisVelocityStore implements VelocityStore {
  constructor(
    private readonly redis: RedisLike,
    private readonly keyPrefix: string = KEY_PREFIX,
  ) {}

  async record(record: BroadcastRecord, teamId: string): Promise<void> {
    // An unknown asset is stored under a sentinel rather than dropped, so it
    // still counts toward the shared count cap and cannot silently escape
    // accounting. `checkFeePayerVelocity` refuses such transactions before
    // reaching here, so this is defence in depth.
    const asset = record.asset ?? "";
    const member = `${asset}|${record.value}|${randomUUID()}`;

    // Written to both keys. The same member string in each is deliberate: it
    // makes a team's contribution to the global window identifiable, and the
    // uuid keeps entries distinct within each set.
    const tKey = teamKey(this.keyPrefix, teamId);
    const gKey = globalKey(this.keyPrefix);

    await this.redis.zadd(tKey, record.at, member);
    await this.redis.zadd(gKey, record.at, member);

    // Prune on write rather than on read: reads happen on the broadcast hot
    // path and must stay a single range scan.
    const cutoff = record.at - RETENTION_MS;
    await this.redis.zremrangebyscore(tKey, 0, cutoff);
    await this.redis.zremrangebyscore(gKey, 0, cutoff);
    await this.redis.pexpire(tKey, KEY_TTL_MS);
    await this.redis.pexpire(gKey, KEY_TTL_MS);
  }

  async teamWindow(
    teamId: string,
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }> {
    const members = await this.redis.zrangebyscore(
      teamKey(this.keyPrefix, teamId),
      now - windowMs,
      "+inf",
    );
    return { valueByAsset: sumVelocityMembers(members), count: members.length };
  }

  async globalWindow(
    now: number,
    windowMs: number,
  ): Promise<{ valueByAsset: Map<string, bigint>; count: number }> {
    const members = await this.redis.zrangebyscore(
      globalKey(this.keyPrefix),
      now - windowMs,
      "+inf",
    );
    return { valueByAsset: sumVelocityMembers(members), count: members.length };
  }
}

/**
 * Known limitation — check-then-record is not atomic across processes.
 *
 * `checkFeePayerVelocity` reads the window, decides, then records. Two workers
 * can both read a just-under-threshold window and both proceed, so with
 * `BULL_CONCURRENCY` workers the cap can be exceeded by up to that many
 * transactions at the boundary.
 *
 * Accepted deliberately: the breaker exists to catch a compromised key or a
 * runaway loop, where the overshoot is orders of magnitude past the limit and a
 * few transactions of slack changes nothing. Closing it properly needs a Lua
 * script doing check-and-record in one round trip, with the precision caveat
 * above — worth doing if the cap is ever tightened to where boundary accuracy
 * matters.
 */
export const VELOCITY_RACE_NOTE = "check-then-record is not atomic; see RedisVelocityStore docs";
