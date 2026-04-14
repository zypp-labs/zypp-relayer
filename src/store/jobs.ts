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
      },
    ])
    .select()
    .single();

  if (error || !data) throw new Error("Insert job failed: " + error?.message);
  data.payload = fromBytea(data.payload);
  log.debug({ jobId: data.id, payloadHash: job.payload_hash }, "Job inserted");
  return data as JobRow;
}

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
  rpcEndpoint: string | null
): Promise<boolean> {
  const payload: any = { status: "failed", last_error: lastError, updated_at: new Date().toISOString() };
  if (rpcEndpoint) payload.rpc_endpoint_used = rpcEndpoint;

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
