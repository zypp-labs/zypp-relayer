import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { Logger } from "../lib/logger.js";
import type { BroadcastJobData } from "../queue/index.js";
import { randomUUID } from "node:crypto";
import { getJobById, findJobByPayloadHash, findJobByIntentSenderNonce, getOpsMetrics, insertJob } from "../store/jobs.js";
import { isTransferIntent, parseIntentPayload, validateTransaction, validateIntent } from "../lib/validate.js";

const ABUSE_SCORE_BLOCK_THRESHOLD = 12;
const ABUSE_SCORE_DECAY_WINDOW_MS = 5 * 60_000;
const ABUSE_BLOCK_MS = 15 * 60_000;
const BATCH_MAX_ITEMS = 20;
const SSE_POLL_MS = 1200;

type AbuseEntry = { score: number; updatedAt: number; blockedUntil?: number };
const abuseByIp = new Map<string, AbuseEntry>();

function getClientIp(request: FastifyRequest): string {
  return request.ip ?? "unknown";
}

function getAbuseEntry(ip: string): AbuseEntry {
  const now = Date.now();
  const current = abuseByIp.get(ip);
  if (!current) {
    const entry = { score: 0, updatedAt: now } satisfies AbuseEntry;
    abuseByIp.set(ip, entry);
    return entry;
  }
  if (now - current.updatedAt > ABUSE_SCORE_DECAY_WINDOW_MS) {
    current.score = Math.max(0, current.score - 2);
  }
  current.updatedAt = now;
  return current;
}

function markAbuse(ip: string, points = 1) {
  const entry = getAbuseEntry(ip);
  entry.score += points;
  if (entry.score >= ABUSE_SCORE_BLOCK_THRESHOLD) {
    entry.blockedUntil = Date.now() + ABUSE_BLOCK_MS;
  }
}

function clearAbuse(ip: string) {
  const entry = getAbuseEntry(ip);
  entry.score = Math.max(0, entry.score - 1);
  if (entry.score < ABUSE_SCORE_BLOCK_THRESHOLD) {
    entry.blockedUntil = undefined;
  }
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: { supabase: SupabaseClient; queue: Queue<BroadcastJobData>; log: Logger; intentDomain: string }
): Promise<void> {
  const { supabase, queue, log, intentDomain } = deps;
  app.addHook("onRequest", async (request, reply) => {
    const ip = getClientIp(request);
    const abuse = getAbuseEntry(ip);
    if (abuse.blockedUntil && abuse.blockedUntil > Date.now()) {
      return reply.status(429).send({
        error: "Too Many Requests",
        code: "ABUSE_BLOCKED",
        message: "Request temporarily blocked due to repeated invalid submissions",
      });
    }

    const expectedApiKey = process.env.RELAYER_API_KEY;
    if (!expectedApiKey) return;
    const provided = request.headers["x-relayer-api-key"];
    if (provided !== expectedApiKey) {
      markAbuse(ip, 2);
      return reply.status(401).send({
        error: "Unauthorized",
        code: "INVALID_API_KEY",
        message: "Missing or invalid relayer API key",
      });
    }
  });

  const submitIntent = async (
    payloadBase64: string,
    ip: string
  ): Promise<
    | { ok: true; response: { jobId: string; status: "queued" } }
    | { ok: false; statusCode: number; response: Record<string, unknown> }
  > => {
    if (typeof payloadBase64 !== "string") {
      markAbuse(ip);
      return {
        ok: false,
        statusCode: 400,
        response: {
          error: "Bad Request",
          code: "INVALID_BODY",
          message: "Body must include 'payload' (base64 string of intent bundle)",
        },
      };
    }

    const validation = await validateIntent(payloadBase64, log, intentDomain);
    if (!validation.ok) {
      markAbuse(ip);
      return {
        ok: false,
        statusCode: 400,
        response: {
          error: "Bad Request",
          code: validation.code,
          message: validation.message,
        },
      };
    }

    const { payload, payloadHash } = validation;
    const parsed = parseIntentPayload(payload);
    if (!parsed.ok) {
      markAbuse(ip);
      return {
        ok: false,
        statusCode: 400,
        response: {
          error: "Bad Request",
          code: parsed.code,
          message: parsed.message,
        },
      };
    }
    const { intent } = parsed.bundle;

    const existing = await findJobByPayloadHash(supabase, payloadHash);
    if (existing) {
      return {
        ok: false,
        statusCode: 409,
        response: {
          error: "Conflict",
          code: "DUPLICATE_INTENT",
          message: "An intent with the same ID is already queued or in progress",
          jobId: existing.id,
          status: existing.status,
        },
      };
    }

    const nonceReplay = await findJobByIntentSenderNonce(supabase, intent.sender, intent.nonce);
    if (nonceReplay) {
      markAbuse(ip);
      return {
        ok: false,
        statusCode: 409,
        response: {
          error: "Conflict",
          code: "DUPLICATE_INTENT",
          message: "An intent with the same sender and nonce already exists",
          jobId: nonceReplay.id,
          status: nonceReplay.status,
        },
      };
    }

    const jobId = randomUUID();
    await insertJob(supabase, log, {
      id: jobId,
      status: "queued",
      payload_hash: payloadHash,
      payload,
      intent_sender: intent.sender,
      intent_nonce: intent.nonce,
      intent_type: isTransferIntent(intent) ? "TRANSFER" : intent.type,
      intent_fee: isTransferIntent(intent) ? String(intent.fee) : null,
      intent_total: isTransferIntent(intent) ? String(intent.total) : null,
      intent_currency: "USDC",
    });
    await queue.add("broadcast", { jobId, type: "intent" } as BroadcastJobData, { jobId });
    clearAbuse(ip);
    log.info({ jobId, payloadHash }, "Intent queued for gasless relay");

    return {
      ok: true,
      response: { jobId, status: "queued" },
    };
  };

  app.post<{ Body: { payload: string } }>(
    "/v1/intents",
    async (request: FastifyRequest<{ Body: { payload: string } }>, reply: FastifyReply) => {
      const result = await submitIntent(request.body?.payload, getClientIp(request));
      if (!result.ok) {
        return reply.status(result.statusCode).send(result.response);
      }
      return reply.status(202).send(result.response);
    }
  );

  app.post<{ Body: { payloads: string[] } }>(
    "/v1/intents/batch",
    async (request: FastifyRequest<{ Body: { payloads: string[] } }>, reply: FastifyReply) => {
      const ip = getClientIp(request);
      const payloads = request.body?.payloads;
      if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > BATCH_MAX_ITEMS) {
        markAbuse(ip);
        return reply.status(400).send({
          error: "Bad Request",
          code: "INVALID_BODY",
          message: `Body must include payloads array with 1-${BATCH_MAX_ITEMS} items`,
        });
      }

      const results: Array<Record<string, unknown>> = [];
      let accepted = 0;
      for (const payload of payloads) {
        const result = await submitIntent(payload, ip);
        if (result.ok) {
          accepted += 1;
          results.push({ statusCode: 202, ...result.response });
        } else {
          results.push({ statusCode: result.statusCode, ...result.response });
        }
      }

      return reply.status(accepted > 0 ? 207 : 400).send({
        accepted,
        total: payloads.length,
        results,
      });
    }
  );

  app.post<{
    Body: { transaction: string };
  }>("/v1/transactions", async (request: FastifyRequest<{ Body: { transaction: string } }>, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body.transaction !== "string") {
      markAbuse(getClientIp(request));
      return reply.status(400).send({
        error: "Bad Request",
        code: "INVALID_BODY",
        message: "Body must include 'transaction' (base64 string)",
      });
    }
    const validation = validateTransaction(body.transaction, log);
    if (!validation.ok) {
      markAbuse(getClientIp(request));
      return reply.status(400).send({
        error: "Bad Request",
        code: validation.code,
        message: validation.message,
      });
    }

    const { payload, payloadHash } = validation;
    const existing = await findJobByPayloadHash(supabase, payloadHash);
    if (existing) {
      return reply.status(409).send({
        error: "Conflict",
        code: "DUPLICATE_TRANSACTION",
        message: "A job with the same transaction is already queued or in progress",
        jobId: existing.id,
        status: existing.status,
      });
    }

    const jobId = randomUUID();
    await insertJob(supabase, log, {
      id: jobId,
      status: "queued",
      payload_hash: payloadHash,
      payload,
    });

    await queue.add("broadcast", { jobId } as BroadcastJobData, { jobId });

    log.info({ jobId, payloadHash }, "Transaction queued");
    return reply.status(202).send({
      jobId,
      status: "queued",
    });
  });

  app.get<{
    Params: { jobId: string };
  }>("/v1/transactions/:jobId", async (request: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
    const { jobId } = request.params;
    const job = await getJobById(supabase, jobId);
    if (!job) {
      return reply.status(404).send({
        error: "Not Found",
        code: "JOB_NOT_FOUND",
        message: "Job not found",
      });
    }
    const payload: Record<string, unknown> = {
      jobId: job.id,
      status: job.status,
      retryCount: job.retry_count,
      lastError: job.last_error,
      createdAt: job.created_at.toISOString(),
      updatedAt: job.updated_at.toISOString(),
    };
    if (job.tx_signature) payload.txSignature = job.tx_signature;
    return reply.send(payload);
  });

  app.get<{
    Params: { jobId: string };
  }>("/v1/transactions/:jobId/stream", async (request, reply) => {
    const { jobId } = request.params;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = async () => {
      const job = await getJobById(supabase, jobId);
      const event = JSON.stringify(
        job
          ? {
            jobId: job.id,
            status: job.status,
            retryCount: job.retry_count,
            lastError: job.last_error,
            txSignature: job.tx_signature,
            updatedAt: job.updated_at.toISOString(),
          }
          : {
            jobId,
            status: "not_found",
          }
      );
      reply.raw.write(`data: ${event}\n\n`);
    };

    await send();
    const timer = setInterval(async () => {
      try {
        await send();
      } catch {
        clearInterval(timer);
      }
    }, SSE_POLL_MS);

    request.raw.on("close", () => clearInterval(timer));
  });

  app.get("/v1/ops/metrics", async (_request, reply) => {
    const metrics = await getOpsMetrics(supabase);
    return reply.send({
      ...metrics,
      abuseTrackedIps: abuseByIp.size,
    });
  });

  app.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    const checks: Record<string, string> = {};
    try {
      const { error } = await supabase.from("jobs").select("id").limit(1);
      if (error) throw error;
      checks.database = "ok";
    } catch (e) {
      checks.database = "error";
      log.warn({ err: e }, "Health check: database failed");
    }
    const redis = queue.opts.connection;
    if (redis && "ping" in redis) {
      try {
        await (redis as { ping: () => Promise<string> }).ping();
        checks.redis = "ok";
      } catch (e) {
        checks.redis = "error";
        log.warn({ err: e }, "Health check: redis failed");
      }
    }
    const allOk = Object.values(checks).every((v) => v === "ok");
    return reply.status(allOk ? 200 : 503).send({
      status: allOk ? "ok" : "degraded",
      checks,
    });
  });
}
