/** Max serialized transaction size per Solana (bytes). */
export const MAX_TX_SIZE = 1232;

/** Job status enum. Must match the `job_status` Postgres enum — see migration 008. */
export type JobStatus = "queued" | "sent" | "confirmed" | "failed" | "acknowledged" | "shunted";

export const JOB_STATUSES: JobStatus[] = ["queued", "sent", "confirmed", "failed", "acknowledged", "shunted"];

export function isTerminalStatus(s: JobStatus): boolean {
  return s === "confirmed" || s === "failed" || s === "acknowledged" || s === "shunted";
}

/**
 * Intent types the relayer will settle. Currently only `payment`.
 *
 * This is an allowlist, and `POST /v1/intents` returns 501
 * INTENT_TYPE_NOT_YET_SUPPORTED for anything absent from it. Ticket and action
 * intents are developer-domain events: the SDK routes them to
 * ExitTarget::DeveloperBackend, and the relayer is not their system of record.
 *
 * A previous version of this comment claimed ticket/action "route through
 * ExitTarget::DeveloperBackend and have no transaction to broadcast" — implying
 * they could never arrive here. They could, and did reach an acknowledge-and-close
 * branch that persisted them. That branch has been removed; this constant is now
 * the enforcement point rather than an assumption about caller behaviour.
 *
 * Adding a type here makes it billable and broadcastable. Do not add one without
 * deciding its metering cost (a payment consumes one credit) and confirming the
 * worker can settle it.
 */
export const INTENT_TYPES_REQUIRING_TRANSACTION: ReadonlySet<string> = new Set(["payment"]);
