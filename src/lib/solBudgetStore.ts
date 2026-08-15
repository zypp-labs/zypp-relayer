import type {
  SolBudgetStore,
  SolBudgetWindow,
  SolReservation,
} from "./solBudget.js";

/**
 * Storage for the rolling SOL budget.
 *
 * Two implementations: in-memory for tests and single-process use, Redis for
 * production. The Redis one is not optional in deployment — a process-local
 * budget is cleared by every restart, and hosts restart on deploy, on scaling,
 * and on idle suspension. A budget that forgets what it spent is not a budget,
 * and one that can be cleared by triggering a restart is a bypass.
 *
 * ## Representation
 *
 * A hash per window, field per reservation: `{id: "teamId|lamports|at"}`.
 *
 * A hash rather than a sorted set because reservations are *mutable* — the whole
 * point of pessimistic reservation is that the held amount shrinks once actual
 * cost is known. Sorted-set members are immutable strings, so reconciling would
 * mean delete-then-add, which is two round trips and a window where the budget
 * reads low.
 *
 * `|` separates fields because team ids are UUIDs and lamports are decimal —
 * neither contains it.
 */

/** In-memory store. Adequate for tests; unsafe as the only store in production. */
export class InMemorySolBudgetStore implements SolBudgetStore {
  private reservations = new Map<string, SolReservation>();

  async reserve(reservation: SolReservation): Promise<void> {
    this.reservations.set(reservation.id, { ...reservation });
  }

  async reconcile(id: string, actualLamports: bigint): Promise<void> {
    const existing = this.reservations.get(id);
    // A missing reservation is not an error: it may have aged out of the window
    // between broadcast and settlement, which is normal for a slow confirmation.
    if (!existing) return;
    this.reservations.set(id, { ...existing, lamports: actualLamports });
  }

  async release(id: string): Promise<void> {
    this.reservations.delete(id);
  }

  async window(teamId: string, now: number, windowMs: number): Promise<SolBudgetWindow> {
    const cutoff = now - windowMs;
    let globalLamports = 0n;
    let teamLamports = 0n;
    let oldestAt: number | null = null;

    for (const r of this.reservations.values()) {
      if (r.at < cutoff) continue;
      globalLamports += r.lamports;
      if (r.teamId === teamId) teamLamports += r.lamports;
      if (oldestAt === null || r.at < oldestAt) oldestAt = r.at;
    }

    return { globalLamports, teamLamports, oldestAt };
  }

  /** Test helper: drop everything. */
  clear(): void {
    this.reservations.clear();
  }
}

/** The Redis surface this store needs. Narrow so tests can fake it. */
export interface RedisHashLike {
  hset(key: string, field: string, value: string): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hdel(key: string, field: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

const DEFAULT_KEY = "zrn:fee-payer:sol-budget";

/** Reservations older than this are pruned on write. Exceeds the longest window. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Key TTL, refreshed on write, so an abandoned budget expires. */
const KEY_TTL_MS = 2 * RETENTION_MS;

function encode(r: SolReservation): string {
  return `${r.teamId}|${r.lamports}|${r.at}`;
}

/**
 * Parse a stored reservation.
 *
 * Returns null on anything malformed rather than throwing. A corrupt field must
 * not take down the whole window read — that would trip the fail-closed path and
 * halt every broadcast, which is worse than under-counting one entry.
 */
function decode(id: string, raw: string): SolReservation | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [teamId, lamportsRaw, atRaw] = parts;
  try {
    const at = Number(atRaw);
    if (!Number.isFinite(at)) return null;
    return { id, teamId, lamports: BigInt(lamportsRaw), at };
  } catch {
    return null;
  }
}

export class RedisSolBudgetStore implements SolBudgetStore {
  constructor(
    private readonly redis: RedisHashLike,
    private readonly key: string = DEFAULT_KEY,
  ) {}

  async reserve(reservation: SolReservation): Promise<void> {
    await this.redis.hset(this.key, reservation.id, encode(reservation));
    await this.redis.pexpire(this.key, KEY_TTL_MS);
  }

  async reconcile(id: string, actualLamports: bigint): Promise<void> {
    const raw = await this.redis.hget(this.key, id);
    if (raw === null) return; // aged out — see InMemory note
    const existing = decode(id, raw);
    if (!existing) return;
    await this.redis.hset(this.key, id, encode({ ...existing, lamports: actualLamports }));
  }

  async release(id: string): Promise<void> {
    await this.redis.hdel(this.key, id);
  }

  async window(teamId: string, now: number, windowMs: number): Promise<SolBudgetWindow> {
    const all = await this.redis.hgetall(this.key);
    const cutoff = now - windowMs;
    const staleCutoff = now - RETENTION_MS;

    let globalLamports = 0n;
    let teamLamports = 0n;
    let oldestAt: number | null = null;
    const stale: string[] = [];

    for (const [id, raw] of Object.entries(all)) {
      const r = decode(id, raw);
      if (!r) {
        // Unparseable entries are swept, not counted. Left in place they would
        // accumulate forever and be re-parsed on every window read.
        stale.push(id);
        continue;
      }
      if (r.at < staleCutoff) {
        stale.push(id);
        continue;
      }
      if (r.at < cutoff) continue;

      globalLamports += r.lamports;
      if (r.teamId === teamId) teamLamports += r.lamports;
      if (oldestAt === null || r.at < oldestAt) oldestAt = r.at;
    }

    // Prune opportunistically. Deliberately not awaited as a batch before
    // returning: the window figure is already computed and correct, and a
    // pruning failure must not fail the read that the broadcast depends on.
    for (const id of stale) {
      void this.redis.hdel(this.key, id).catch(() => undefined);
    }

    return { globalLamports, teamLamports, oldestAt };
  }
}
