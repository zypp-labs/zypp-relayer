import type { JobStatus } from "../lib/constants.js";

export interface JobRow {
  id: string;
  created_at: Date;
  updated_at: Date;
  status: JobStatus;
  retry_count: number;
  last_error: string | null;
  tx_signature: string | null;
  payload_hash: string;
  payload: Buffer;
  rpc_endpoint_used: string | null;
  intent_sender: string | null;
  intent_nonce: string | null;
  intent_type: string | null;
  intent_fee: string | null;
  intent_total: string | null;
  intent_currency: string | null;
}

export interface JobInsert {
  id: string;
  status: JobStatus;
  payload_hash: string;
  payload: Buffer;
  intent_sender?: string | null;
  intent_nonce?: string | null;
  intent_type?: string | null;
  intent_fee?: string | null;
  intent_total?: string | null;
  intent_currency?: string | null;
}

export interface JobStatusUpdate {
  status: JobStatus;
  last_error?: string | null;
  tx_signature?: string | null;
  rpc_endpoint_used?: string | null;
  updated_at?: Date;
}

export interface AuditLogRow {
  id: number;
  job_id: string;
  from_status: JobStatus | null;
  to_status: JobStatus;
  created_at: Date;
}
