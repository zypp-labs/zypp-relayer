import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRow, JobInsert, JobStatusUpdate } from "./types.js";
import type { JobStatus } from "../lib/constants.js";
import type { Logger } from "../lib/logger.js";

// Helper to convert Buffer to/from Postgres bytea hex format
function toBytea(buf: Buffer): string {
  return "\\x" + buf.toString("hex");
}

function fromBytea(str: string): Buffer {
  if (str.startsWith("\\x")) return Buffer.from(str.slice(2), "hex");
  return Buffer.from(str, "hex");
}

export async function insertJob(
  supabase: SupabaseClient,
  log: Logger,
  job: JobInsert
): Promise<JobRow> {
  const { data, error } = await supabase
    .from("jobs")
    .insert([
      {
        id: job.id,
        status: job.status,
        payload_hash: job.payload_hash,
        payload: toBytea(job.payload),
        intent_sender: job.intent_sender ?? null,
        intent_nonce: job.intent_nonce ?? null,
        intent_type: job.intent_type ?? null,
        intent_fee: job.intent_fee ?? null,
        intent_total: job.intent_total ?? null,
        intent_currency: job.intent_currency ?? null,
        failure_stage: job.failure_stage ?? null,
        failure_code: job.failure_code ?? null,
        intent_envelope: job.intent_envelope ?? null,
        team_id: job.team_id ?? null,
        degraded: job.degraded ?? false,
      },
    ])
    .select()
    .single();

  if (error || !data) throw new Error("Insert job failed: " + error?.message);
  data.payload = fromBytea(data.payload);
  log.debug({ jobId: data.id, payloadHash: job.payload_hash }, "Job inserted");
  return data as JobRow;
}

/**
 * Fetch a job by id with no tenant filter.
 *
 * For internal/worker use only, where the caller is the system itself and there
 * is no requesting team. API request handlers must use `getJobByIdForTeam` —
 * serving this result to an API caller leaks other tenants' jobs.
 */
export async function getJobById(
  supabase: SupabaseClient,
  jobId: string
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  data.payload = fromBytea(data.payload);
  return data as JobRow;
}

/**
 * Fetch a job by id, scoped to the owning team.
 *
 * Returns null both when the job does not exist and when it belongs to another
 * team, so callers cannot distinguish the two — a 404 for someone else's job
 * must not confirm that the id is real.
 */
export async function getJobByIdForTeam(
  supabase: SupabaseClient,
  jobId: string,
  teamId: string
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  data.payload = fromBytea(data.payload);
  return data as JobRow;
}

/** Find an existing non-failed job with the same payload hash (for duplicate detection). */
export async function findJobByPayloadHash(
  supabase: SupabaseClient,
  payloadHash: string
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("payload_hash", payloadHash)
    .in("status", ["queued", "sent"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  data.payload = fromBytea(data.payload);
  return data as JobRow;
}

/** Find any existing job for a sender+nonce pair to prevent replay. */
export async function findJobByIntentSenderNonce(
  supabase: SupabaseClient,
  sender: string,
  nonce: string
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("intent_sender", sender)
    .eq("intent_nonce", nonce)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  data.payload = fromBytea(data.payload);
  return data as JobRow;
}

export async function getOpsMetrics(supabase: SupabaseClient) {
  const { data, error } = await supabase.rpc("get_ops_metrics");
  if (error) throw error;
  return data;
}

/**
 * Per-team job counts and confirmed-transfer economics.
 *
 * The `get_ops_metrics()` RPC aggregates every row in `jobs` regardless of
 * owner, so it cannot be served to an API caller. This computes the same shape
 * from a team-scoped read.
 */
export async function getOpsMetricsForTeam(
  supabase: SupabaseClient,
  teamId: string,
) {
  const { data, error } = await supabase
    .from("jobs")
    .select("status, intent_fee, intent_total")
    .eq("team_id", teamId);

  if (error) throw error;
  const rows = (data ?? []) as Array<{
    status: JobStatus;
    intent_fee: string | null;
    intent_total: string | null;
  }>;

  const countOf = (s: JobStatus) => rows.filter((r) => r.status === s).length;
  const confirmed = rows.filter((r) => r.status === "confirmed");
  const sum = (pick: (r: (typeof rows)[number]) => string | null) =>
    confirmed.reduce((total, r) => {
      const v = pick(r);
      return v === null ? total : total + Number(v);
    }, 0);

  const feesCollected = sum((r) => r.intent_fee);
  const withFee = confirmed.filter((r) => r.intent_fee !== null).length;

  return {
    counts: {
      queued: String(countOf("queued")),
      sent: String(countOf("sent")),
      confirmed: String(confirmed.length),
      failed: String(countOf("failed")),
      total: String(rows.length),
    },
    economics: {
      fees_collected_usdc: String(feesCollected),
      transfer_total_usdc: String(sum((r) => r.intent_total)),
      avg_confirmed_fee_usdc: String(withFee > 0 ? feesCollected / withFee : 0),
    },
  };
}

/**
 * Recent jobs with no tenant filter — internal/ops use only.
 * API request handlers must use `getRecentJobsForTeam`.
 */
export async function getRecentJobs(supabase: SupabaseClient, limit = 20) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, payload_hash, intent_sender, intent_nonce, intent_type, intent_fee, intent_total, intent_currency, tx_signature, rpc_endpoint_used, last_error, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

/** Recent jobs for one team. */
export async function getRecentJobsForTeam(
  supabase: SupabaseClient,
  teamId: string,
  limit = 20,
) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, payload_hash, intent_sender, intent_nonce, intent_type, intent_fee, intent_total, intent_currency, tx_signature, rpc_endpoint_used, last_error, created_at, updated_at")
    .eq("team_id", teamId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function updateJobStatus(
  supabase: SupabaseClient,
  log: Logger,
  jobId: string,
  update: JobStatusUpdate,
  options: { incrementRetry?: boolean } = {}
): Promise<void> {
  const payload: any = {
    status: update.status,
    updated_at: new Date().toISOString(),
  };
  if (update.last_error !== undefined) payload.last_error = update.last_error;
  if (update.tx_signature !== undefined) payload.tx_signature = update.tx_signature;
  if (update.rpc_endpoint_used !== undefined) payload.rpc_endpoint_used = update.rpc_endpoint_used;
  if (update.failure_stage !== undefined) payload.failure_stage = update.failure_stage;
  if (update.failure_code !== undefined) payload.failure_code = update.failure_code;

  const { error } = await supabase
    .from("jobs")
    .update(payload)
    .eq("id", jobId);

  if (error) throw error;

  if (options.incrementRetry) {
    await supabase.rpc("increment_job_retry", { p_job_id: jobId });
  }

  log.debug(
    { jobId, status: update.status, lastError: update.last_error },
    "Job status updated"
  );
}

export async function appendAuditLog(
  supabase: SupabaseClient,
  jobId: string,
  fromStatus: JobStatus | null,
  toStatus: JobStatus
): Promise<void> {
  const { error } = await supabase
    .from("audit_log")
    .insert([{ job_id: jobId, from_status: fromStatus, to_status: toStatus }]);

  if (error) throw error;
}

/** Transition job to sent (broadcast succeeded); only if current status is queued. */
export async function markJobSent(
  supabase: SupabaseClient,
  log: Logger,
  jobId: string,
  rpcEndpoint: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "sent", rpc_endpoint_used: rpcEndpoint, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "queued")
    .select("id");

  if (error) throw error;
  const updated = data && data.length > 0;
  if (updated) {
    await appendAuditLog(supabase, jobId, "queued", "sent");
    log.debug({ jobId, rpcEndpoint }, "Job marked sent");
  }
  return updated;
}

/** Transition job to confirmed; only if current status is queued or sent. */
export async function markJobConfirmed(
  supabase: SupabaseClient,
  log: Logger,
  jobId: string,
  txSignature: string,
  rpcEndpoint: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("jobs")
    .update({ status: "confirmed", tx_signature: txSignature, rpc_endpoint_used: rpcEndpoint, updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .in("status", ["queued", "sent"])
    .select("status");

  if (error) throw error;
  const updated = data && data.length > 0;
  if (updated) {
    await appendAuditLog(supabase, jobId, data[0].status as JobStatus, "confirmed");
    log.info({ jobId, txSignature, rpcEndpoint }, "Job confirmed");
  }
  return updated;
}

/** Mark job failed (permanent); only if current status is queued or sent. */
export async function markJobFailed(
  supabase: SupabaseClient,
  log: Logger,
  jobId: string,
  lastError: string,
  rpcEndpoint: string | null,
  failureStage?: string | null,
  failureCode?: string | null,
): Promise<boolean> {
  const payload: any = { status: "failed", last_error: lastError, updated_at: new Date().toISOString() };
  if (rpcEndpoint) payload.rpc_endpoint_used = rpcEndpoint;
  if (failureStage !== undefined) payload.failure_stage = failureStage;
  if (failureCode !== undefined) payload.failure_code = failureCode;

  const { data, error } = await supabase
    .from("jobs")
    .update(payload)
    .eq("id", jobId)
    .in("status", ["queued", "sent"])
    .select("status");

  if (error) throw error;
  const updated = data && data.length > 0;
  if (updated) {
    await appendAuditLog(supabase, jobId, data[0].status as JobStatus, "failed");
    log.warn({ jobId, lastError, rpcEndpoint }, "Job failed");
  }
  return updated;
}

/** Increment retry count (e.g. when we will retry after transient error). */
export async function incrementJobRetry(
  supabase: SupabaseClient,
  jobId: string
): Promise<void> {
  const { error } = await supabase.rpc("increment_job_retry", { p_job_id: jobId });
  if (error) throw error;
}
