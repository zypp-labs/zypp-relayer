/** Max serialized transaction size per Solana (bytes). */
export const MAX_TX_SIZE = 1232;

/** Job status enum. */
export type JobStatus = "queued" | "sent" | "confirmed" | "failed";

export const JOB_STATUSES: JobStatus[] = ["queued", "sent", "confirmed", "failed"];

export function isTerminalStatus(s: JobStatus): boolean {
  return s === "confirmed" || s === "failed";
}
