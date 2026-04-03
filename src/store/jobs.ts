import type { Pool } from "pg";
import type { JobRow, JobInsert, JobStatusUpdate } from "./types.js";
import type { JobStatus } from "../lib/constants.js";
import type { Logger } from "../lib/logger.js";

export async function insertJob(
  pool: Pool,
  log: Logger,
  job: JobInsert
): Promise<JobRow> {
  const result = await pool.query<JobRow>(
    `INSERT INTO jobs (id, status, payload_hash, payload)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at, updated_at, status, retry_count, last_error,
               tx_signature, payload_hash, payload, rpc_endpoint_used`,
    [job.id, job.status, job.payload_hash, job.payload]
  );
  const row = result.rows[0];
  if (!row) throw new Error("Insert job failed");
  log.debug({ jobId: row.id, payloadHash: job.payload_hash }, "Job inserted");
  return row;
}

export async function getJobById(
  pool: Pool,
  jobId: string
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `SELECT id, created_at, updated_at, status, retry_count, last_error,
            tx_signature, payload_hash, payload, rpc_endpoint_used
     FROM jobs WHERE id = $1`,
    [jobId]
  );
  return result.rows[0] ?? null;
}

/** Find an existing non-failed job with the same payload hash (for duplicate detection). */
export async function findJobByPayloadHash(
  pool: Pool,
  payloadHash: string
): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `SELECT id, created_at, updated_at, status, retry_count, last_error,
            tx_signature, payload_hash, payload, rpc_endpoint_used
     FROM jobs
     WHERE payload_hash = $1 AND status IN ('queued', 'sent')
     ORDER BY created_at DESC
     LIMIT 1`,
    [payloadHash]
  );
  return result.rows[0] ?? null;
}

export async function updateJobStatus(
  pool: Pool,
  log: Logger,
  jobId: string,
  update: JobStatusUpdate,
  options: { incrementRetry?: boolean } = {}
): Promise<void> {
  const updates: string[] = [
    "status = $2",
    "last_error = $3",
    "tx_signature = COALESCE($4, tx_signature)",
    "rpc_endpoint_used = COALESCE($5, rpc_endpoint_used)",
    "updated_at = now()",
  ];
  const params: unknown[] = [
    jobId,
    update.status,
    update.last_error ?? null,
    update.tx_signature ?? null,
    update.rpc_endpoint_used ?? null,
  ];
  if (options.incrementRetry) {
    updates.push("retry_count = retry_count + 1");
  }
  const setClause = updates.join(", ");
  await pool.query(
    `UPDATE jobs SET ${setClause} WHERE id = $1`,
    params
  );

  log.debug(
    { jobId, status: update.status, lastError: update.last_error },
    "Job status updated"
  );
}

export async function appendAuditLog(
  pool: Pool,
  jobId: string,
  fromStatus: JobStatus | null,
  toStatus: JobStatus
): Promise<void> {
  await pool.query(
    `INSERT INTO audit_log (job_id, from_status, to_status) VALUES ($1, $2, $3)`,
    [jobId, fromStatus, toStatus]
  );
}

/** Transition job to sent (broadcast succeeded); only if current status is queued. */
export async function markJobSent(
  pool: Pool,
  log: Logger,
  jobId: string,
  rpcEndpoint: string
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs SET status = 'sent', rpc_endpoint_used = $2, updated_at = now()
     WHERE id = $1 AND status = 'queued'
     RETURNING id`,
    [jobId, rpcEndpoint]
  );
  const updated = result.rowCount !== null && result.rowCount > 0;
  if (updated) {
    await appendAuditLog(pool, jobId, "queued", "sent");
    log.debug({ jobId, rpcEndpoint }, "Job marked sent");
  }
  return updated;
}

/** Transition job to confirmed; only if current status is queued or sent. */
export async function markJobConfirmed(
  pool: Pool,
  log: Logger,
  jobId: string,
  txSignature: string,
  rpcEndpoint: string
): Promise<boolean> {
  const result = await pool.query<{ status: JobStatus }>(
    `UPDATE jobs SET status = 'confirmed', tx_signature = $2, rpc_endpoint_used = $3, updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'sent')
     RETURNING status`,
    [jobId, txSignature, rpcEndpoint]
  );
  const row = result.rows[0];
  if (!row) return false;
  await appendAuditLog(pool, jobId, row.status, "confirmed");
  log.info({ jobId, txSignature, rpcEndpoint }, "Job confirmed");
  return true;
}

/** Mark job failed (permanent); only if current status is queued or sent. */
export async function markJobFailed(
  pool: Pool,
  log: Logger,
  jobId: string,
  lastError: string,
  rpcEndpoint: string | null
): Promise<boolean> {
  const result = await pool.query<{ status: JobStatus }>(
    `UPDATE jobs SET status = 'failed', last_error = $2, rpc_endpoint_used = COALESCE($3, rpc_endpoint_used), updated_at = now()
     WHERE id = $1 AND status IN ('queued', 'sent')
     RETURNING status`,
    [jobId, lastError, rpcEndpoint]
  );
  const row = result.rows[0];
  if (!row) return false;
  await appendAuditLog(pool, jobId, row.status, "failed");
  log.warn({ jobId, lastError, rpcEndpoint }, "Job failed");
  return true;
}

/** Increment retry count (e.g. when we will retry after transient error). */
export async function incrementJobRetry(
  pool: Pool,
  jobId: string
): Promise<void> {
  await pool.query(
    `UPDATE jobs SET retry_count = retry_count + 1, updated_at = now() WHERE id = $1`,
    [jobId]
  );
}
