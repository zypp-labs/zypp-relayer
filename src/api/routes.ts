import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { Pool } from "pg";
import type { Queue } from "bullmq";
import type { Logger } from "../lib/logger.js";
import type { BroadcastJobData } from "../queue/index.js";
import { randomUUID } from "node:crypto";
import { getJobById, findJobByPayloadHash, insertJob } from "../store/jobs.js";
import { validateTransaction } from "../lib/validate.js";

export async function registerRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; queue: Queue<BroadcastJobData>; log: Logger }
): Promise<void> {
  const { pool, queue, log } = deps;

  app.post<{
    Body: { transaction: string };
  }>("/v1/transactions", async (request: FastifyRequest<{ Body: { transaction: string } }>, reply: FastifyReply) => {
    const body = request.body;
    if (!body || typeof body.transaction !== "string") {
      return reply.status(400).send({
        error: "Bad Request",
        code: "INVALID_BODY",
        message: "Body must include 'transaction' (base64 string)",
      });
    }
    const validation = validateTransaction(body.transaction, log);
    if (!validation.ok) {
      return reply.status(400).send({
        error: "Bad Request",
        code: validation.code,
        message: validation.message,
      });
    }
    const { payload, payloadHash } = validation;

    const existing = await findJobByPayloadHash(pool, payloadHash);
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
    await insertJob(pool, log, {
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
    const job = await getJobById(pool, jobId);
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

  app.get("/health", async (_request: FastifyRequest, reply: FastifyReply) => {
    const checks: Record<string, string> = {};
    try {
      await pool.query("SELECT 1");
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
