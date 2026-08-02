import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queue } from "bullmq";
import type { Logger } from "../lib/logger.js";
import type { Config } from "../lib/config.js";
import type { BroadcastJobData } from "../queue/index.js";
import { randomUUID } from "node:crypto";
import { getJobByIdForTeam, findJobByPayloadHash, findJobByIntentSenderNonce, getOpsMetricsForTeam, getRecentJobsForTeam, insertJob, updateJobStatus } from "../store/jobs.js";
import { isTransferIntent, parseIntentPayload, validateIntent } from "../lib/validate.js";
import { validateV1Envelope } from "../lib/validateV1.js";
import { INTENT_TYPES_REQUIRING_TRANSACTION } from "../lib/constants.js";
import { RelayerFailureStage } from "../lib/failureCodes.js";
import { findTeamByApiKey, touchApiKey } from "../store/apiKeys.js";
import { processShunt } from "../lib/shunt.js";

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

type RouteDeps = {
  supabase: SupabaseClient;
  queue: Queue<BroadcastJobData>;
  log: Logger;
  intentDomain: string;
  config: Config;
};

declare module "fastify" {
  interface FastifyRequest {
    teamId?: string;
  }
}

export async function registerRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  const { supabase, queue, log, intentDomain, config } = deps;

  app.get("/", async (_request, reply) => {
    return reply.send({
      name: "Zypp Relayer",
      description: "Transaction relay infrastructure for offline-first payments on Solana. Built by Zypp Labs.",
      version: "v1",
      status: "operational",
      docs: "https://relayer.zypp.fun/docs",
      base_url: "https://relayer.zypp.fun",
      built_by: "Zypp Labs",
      website: "https://zypp.fun",
    });
  });

  app.get("/docs", async (_request, reply) => {
    return reply.redirect("https://relayer.zypp.fun/docs", 302);
  });

  app.get("/robots.txt", async (_request, reply) => {
    return reply
      .header("Content-Type", "text/plain")
      .send("User-agent: *\nAllow: /\nAllow: /docs\nDisallow: /v1/ops/");
  });

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

    const provided = request.headers["x-api-key"] as string | undefined;
    if (!provided) {
      markAbuse(ip, 2);
      return reply.status(401).send({
        error: "Unauthorized",
        code: "MISSING_API_KEY",
        message: "x-api-key header required",
      });
    }

    const team = await findTeamByApiKey(supabase, provided);
    if (!team) {
      markAbuse(ip, 2);
      return reply.status(401).send({
        error: "Unauthorized",
        code: "INVALID_API_KEY",
        message: "Invalid or revoked API key",
      });
    }

    request.teamId = team.teamId;
    void touchApiKey(supabase, provided).catch((err) =>
      log.warn({ err }, "Failed to update api_key last_used_at")
    );
  });

  const submitLegacyIntent = async (
    payloadBase64: string,
    ip: string,
    teamId: string
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
          failureStage: RelayerFailureStage.Validation,
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
          failureStage: RelayerFailureStage.Validation,
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
          failureStage: RelayerFailureStage.Validation,
        },
      };
    }
    const { intent } = parsed.bundle;

    // Same cross-tenant reasoning as the v1 path: dedup and replay lookups are
    // intentionally global, so a conflict may belong to another team. Echo the
    // conflicting job's identifiers only when the caller owns it.
    const existing = await findJobByPayloadHash(supabase, payloadHash);
    if (existing) {
      const ownJob = existing.team_id === teamId;
      log.info(
        { conflictJobId: existing.id, ownJob, teamId },
        "Legacy intent rejected: duplicate payload hash",
      );
      return {
        ok: false,
        statusCode: 409,
        response: {
          error: "Conflict",
          code: "DUPLICATE_INTENT",
          message: "An intent with the same ID is already queued or in progress",
          ...(ownJob ? { jobId: existing.id, status: existing.status } : {}),
          failureStage: RelayerFailureStage.Validation,
        },
      };
    }

    const nonceReplay = await findJobByIntentSenderNonce(supabase, intent.sender, intent.nonce);
    if (nonceReplay) {
      const ownJob = nonceReplay.team_id === teamId;
      markAbuse(ip);
      log.info(
        { conflictJobId: nonceReplay.id, ownJob, teamId },
        "Legacy intent rejected: sender+nonce replay",
      );
      return {
        ok: false,
        statusCode: 409,
        response: {
          error: "Conflict",
          code: "DUPLICATE_INTENT",
          message: "An intent with the same sender and nonce already exists",
          ...(ownJob ? { jobId: nonceReplay.id, status: nonceReplay.status } : {}),
          failureStage: RelayerFailureStage.Validation,
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
      team_id: teamId,
    });
    await queue.add("broadcast", { jobId, type: "intent" } as BroadcastJobData, { jobId });
    clearAbuse(ip);
    log.info({ jobId, payloadHash }, "Intent queued for gasless relay");

    return {
      ok: true,
      response: { jobId, status: "queued" },
    };
  };

  const submitV1Envelope = async (
    body: Record<string, unknown>,
    ip: string,
    teamId: string,
  ): Promise<
    | { ok: true; response: { jobId: string; status: "queued" | "shunted" } }
    | { ok: false; statusCode: number; response: Record<string, unknown> }
  > => {
    const validation = validateV1Envelope(body, log);
    if (!validation.ok) {
      markAbuse(ip);
      return {
        ok: false,
        statusCode: 400,
        response: {
          error: "Bad Request",
          code: validation.code,
          message: validation.message,
          failureStage: RelayerFailureStage.Validation,
        },
      };
    }

    const { envelope, txBytes, payloadHash } = validation;

    // The relayer settles payment intents only. Ticket and action intents are
    // developer-domain events: the SDK's own routing model sends them to
    // ExitTarget::DeveloperBackend, and Zypp is not their system of record.
    //
    // An earlier "acknowledge and close" branch persisted them here with status
    // 'acknowledged'. That was removed — it wrote a row nothing read, notified
    // nobody (webhook delivery is unimplemented), and accepted an unverified
    // intent_sender, since non-payment intents require no signature and never
    // reach the worker's Ed25519 gate. That let any valid API key write rows
    // attributed to an arbitrary public key, and squat the global
    // (sender, nonce) namespace against a victim's future payment intents.
    //
    // 501 rather than 400: this is "not routed through the relayer yet", not
    // "your request is malformed". The 'acknowledged' enum value is retained in
    // the schema (Postgres cannot drop an enum value) and is now unwritten.
    if (!INTENT_TYPES_REQUIRING_TRANSACTION.has(envelope.intent)) {
      // Deliberately no markAbuse() here. Reaching this branch means following
      // the SDK's documented surface — exportIntentToJSON/submitIntentToRelayer
      // accept any intent kind — so it is an integration mismatch, not abuse.
      // Penalising it would IP-block an honest developer after ~6 requests.
      return {
        ok: false,
        statusCode: 501,
        response: {
          error: "Not Implemented",
          code: "INTENT_TYPE_NOT_YET_SUPPORTED",
          message:
            `The relayer settles payment intents only; '${envelope.intent}' is not routed ` +
            "through it yet. Ticket and action intents are delivered to your own backend " +
            "endpoint — see the SDK's ExitTarget::DeveloperBackend.",
          intent: envelope.intent,
        },
      };
    }

    // Dedup and replay checks are deliberately global, NOT team-scoped: the same
    // wallet may submit through several teams' API keys, and a payload hash or
    // (sender, nonce) pair must be single-use across all of them or replay
    // protection is defeated.
    //
    // The consequence is that a conflict may be against another team's job, so
    // the response must not echo that job's id or status — doing so leaked
    // cross-tenant identifiers to any caller who could provoke a collision.
    // Only whether a conflict occurred is disclosed. The jobId is logged
    // server-side for support.
    const existing = await findJobByPayloadHash(supabase, payloadHash);
    if (existing) {
      const ownJob = existing.team_id === teamId;
      log.info(
        { conflictJobId: existing.id, ownJob, teamId },
        "V1 envelope rejected: duplicate payload hash",
      );
      return {
        ok: false,
        statusCode: 409,
        response: {
          error: "Conflict",
          code: "DUPLICATE_INTENT",
          message: "An intent with the same payload hash is already queued or in progress",
          // Disclosed only when the caller already owns the job.
          ...(ownJob ? { jobId: existing.id, status: existing.status } : {}),
          failureStage: RelayerFailureStage.Validation,
        },
      };
    }

    const sender = envelope.signature?.publicKey ?? "";
    const nonce = envelope.signature?.nonce ?? 0;
    if (sender && nonce) {
      const nonceReplay = await findJobByIntentSenderNonce(supabase, sender, String(nonce));
      if (nonceReplay) {
        const ownJob = nonceReplay.team_id === teamId;
        markAbuse(ip);
        log.info(
          { conflictJobId: nonceReplay.id, ownJob, teamId },
          "V1 envelope rejected: sender+nonce replay",
        );
        return {
          ok: false,
          statusCode: 409,
          response: {
            error: "Conflict",
            code: "DUPLICATE_INTENT",
            message: "An intent with the same sender and nonce already exists",
            ...(ownJob ? { jobId: nonceReplay.id, status: nonceReplay.status } : {}),
            failureStage: RelayerFailureStage.Validation,
          },
        };
      }
    }

    const jobId = randomUUID();

    // Every intent reaching this point requires a transaction — the guard above
    // returned 501 for anything else, so txBytes is guaranteed present by
    // validateV1Envelope's TRANSACTION_REQUIRED check.
    const creditRpc = await supabase
      .rpc("try_consume_credit", { p_team_id: teamId });
    const creditResult = (creditRpc.data ?? null) as { has_credit: boolean; degraded: boolean } | null;

    const degraded = !creditResult || !creditResult.has_credit;

    if (degraded) {
      const shuntResult = await processShunt(txBytes!, envelope, config, log);

      if (!shuntResult.ok) {
        log.warn({ teamId, jobId, error: shuntResult.error }, "Shunt processing failed — marking job as failed");

        await insertJob(supabase, log, {
          id: jobId,
          status: "failed",
          payload_hash: payloadHash,
          payload: txBytes!,
          intent_sender: sender || null,
          intent_nonce: nonce ? String(nonce) : null,
          intent_type: envelope.intent.toUpperCase(),
          intent_currency: (envelope.payload?.asset as string) ?? null,
          intent_envelope: JSON.stringify(envelope),
          team_id: teamId,
          degraded: true,
        });

        await updateJobStatus(supabase, log, jobId, {
          status: "failed",
          last_error: shuntResult.error,
          rpc_endpoint_used: config.PUBLIC_RPC_URL,
        });

        clearAbuse(ip);

        return {
          ok: false,
          statusCode: 500,
          response: {
            error: "Internal Server Error",
            code: "SHUNT_FAILED",
            message: "Degraded processing failed. Please retry.",
            jobId,
          },
        };
      }

      await insertJob(supabase, log, {
        id: jobId,
        status: "shunted",
        payload_hash: payloadHash,
        payload: txBytes!,
        intent_sender: sender || null,
        intent_nonce: nonce ? String(nonce) : null,
        intent_type: envelope.intent.toUpperCase(),
        intent_currency: (envelope.payload?.asset as string) ?? null,
        intent_envelope: JSON.stringify(envelope),
        team_id: teamId,
        degraded: true,
      });

      await updateJobStatus(supabase, log, jobId, {
        status: "shunted",
        tx_signature: shuntResult.signature,
        rpc_endpoint_used: config.PUBLIC_RPC_URL,
      });

      clearAbuse(ip);
      log.info({ jobId, payloadHash, intent: envelope.intent, degraded: true }, "V1 envelope shunted");

      return {
        ok: true,
        response: { jobId, status: "shunted" as const },
      };
    }

    await insertJob(supabase, log, {
      id: jobId,
      status: "queued",
      payload_hash: payloadHash,
      payload: txBytes!,
      intent_sender: sender || null,
      intent_nonce: nonce ? String(nonce) : null,
      intent_type: envelope.intent.toUpperCase(),
      intent_currency: (envelope.payload?.asset as string) ?? null,
      intent_envelope: JSON.stringify(envelope),
      team_id: teamId,
      degraded: false,
    });
    await queue.add("broadcast", { jobId, type: "intent" } as BroadcastJobData, { jobId });
    clearAbuse(ip);
    log.info({ jobId, payloadHash, intent: envelope.intent, teamId }, "V1 envelope queued");

    return {
      ok: true,
      response: { jobId, status: "queued" },
    };
  };

  app.post<{ Body: Record<string, unknown> }>(
    "/v1/intents",
    async (request: FastifyRequest<{ Body: Record<string, unknown> }>, reply: FastifyReply) => {
      const body = request.body ?? {};
      const ip = getClientIp(request);

      if (body.payload && typeof body.payload === "string") {
        if (body.version) {
          markAbuse(ip);
          return reply.status(400).send({
            error: "Bad Request",
            code: "AMBIGUOUS_FORMAT",
            message: "Request contains both 'payload' (legacy base64) and 'version' (JSON envelope). Use only one format.",
            failureStage: RelayerFailureStage.Validation,
          });
        }
        reply.header("Deprecation-Warning", "The base64 payload format is deprecated. Migrate to the v1 JSON envelope format (see https://docs.zypp.fun/relayer-v2).");
        const result = await submitLegacyIntent(body.payload as string, ip, request.teamId!);
        if (!result.ok) {
          return reply.status(result.statusCode).send(result.response);
        }
        return reply.status(202).send(result.response);
      }

      if (body.version) {
        const version = Number(body.version);
        if (version === 1) {
          const result = await submitV1Envelope(body, ip, request.teamId!);
          if (!result.ok) {
            return reply.status(result.statusCode).send(result.response);
          }
          return reply.status(202).send(result.response);
        }
        markAbuse(ip);
        return reply.status(400).send({
          error: "Bad Request",
          code: "UNSUPPORTED_VERSION",
          message: `Unsupported version ${version}, max supported: 1`,
          failureStage: RelayerFailureStage.Validation,
        });
      }

      markAbuse(ip);
      return reply.status(400).send({
        error: "Bad Request",
        code: "INVALID_BODY",
        message: "Body must include 'payload' (base64 string) or 'version' (JSON envelope)",
        failureStage: RelayerFailureStage.Validation,
      });
    }
  );

  app.post<{ Body: { payloads?: unknown[] } }>(
    "/v1/intents/batch",
    async (request: FastifyRequest<{ Body: { payloads?: unknown[] } }>, reply: FastifyReply) => {
      const ip = getClientIp(request);
      const payloads = request.body?.payloads;
      if (!Array.isArray(payloads) || payloads.length === 0 || payloads.length > BATCH_MAX_ITEMS) {
        markAbuse(ip);
        return reply.status(400).send({
          error: "Bad Request",
          code: "INVALID_BODY",
          message: `Body must include payloads array with 1-${BATCH_MAX_ITEMS} items`,
          failureStage: RelayerFailureStage.Validation,
        });
      }

      const results: Array<Record<string, unknown>> = [];
      let accepted = 0;
      let hasLegacy = false;
      const teamId = request.teamId!;
      for (const item of payloads) {
        if (typeof item === "string") {
          hasLegacy = true;
          const result = await submitLegacyIntent(item, ip, teamId);
          if (result.ok) {
            accepted += 1;
            results.push({ statusCode: 202, ...result.response });
          } else {
            results.push({ statusCode: result.statusCode, ...result.response });
          }
        } else if (item && typeof item === "object" && "version" in (item as Record<string, unknown>)) {
          const result = await submitV1Envelope(item as Record<string, unknown>, ip, teamId);
          if (result.ok) {
            accepted += 1;
            results.push({ statusCode: 202, ...result.response });
          } else {
            results.push({ statusCode: result.statusCode, ...result.response });
          }
        } else {
          markAbuse(ip);
          results.push({ statusCode: 400, error: "Bad Request", code: "INVALID_ITEM", message: "Each item must be a base64 string (legacy) or a JSON object with a version field", failureStage: RelayerFailureStage.Validation });
        }
      }

      if (hasLegacy) {
        reply.header("Deprecation-Warning", "The base64 payload format is deprecated. Migrate to the v1 JSON envelope format (see https://docs.zypp.fun/relayer-v2).");
      }

      return reply.status(accepted > 0 ? 207 : 400).send({
        accepted,
        total: payloads.length,
        results,
      });
    }
  );

  app.get<{
    Params: { jobId: string };
  }>("/v1/transactions/:jobId", async (request: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
    const { jobId } = request.params;
    const job = await getJobByIdForTeam(supabase, jobId, request.teamId!);
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
  }>("/v1/intents/:jobId", async (request: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
    const { jobId } = request.params;
    const job = await getJobByIdForTeam(supabase, jobId, request.teamId!);
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
    if (job.failure_stage) payload.failureStage = job.failure_stage;
    if (job.failure_code) payload.failureCode = job.failure_code;
    if (job.degraded) payload.degraded = true;
    return reply.send(payload);
  });

  app.get<{
    Params: { jobId: string };
  }>("/v1/transactions/:jobId/stream", async (request, reply) => {
    const { jobId } = request.params;
    const teamId = request.teamId!;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Scoped per poll, not once at open: a job's ownership cannot change, but
    // re-checking keeps the authorisation decision colocated with every read
    // rather than relying on a check that happened seconds or minutes earlier.
    const send = async () => {
      const job = await getJobByIdForTeam(supabase, jobId, teamId);
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

  // Scoped to the calling team. This previously served platform-wide aggregates
  // — every team's job counts and confirmed-transfer economics — to any caller
  // holding a valid API key.
  app.get("/v1/ops/metrics", async (request, reply) => {
    const teamId = request.teamId!;
    const metrics = await getOpsMetricsForTeam(supabase, teamId);
    const { count: shunted } = await supabase
      .from("jobs")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId)
      .eq("degraded", true);
    return reply.send({
      ...metrics,
      shunted: shunted ?? 0,
      // Deliberately omits abuseTrackedIps: that is a process-wide count
      // reflecting all traffic to this instance, not the caller's own activity.
    });
  });

  // Scoped to the calling team. This previously returned every team's recent
  // jobs, including intent_sender, fee economics, and tx signatures — and the
  // job ids it disclosed unlocked the by-id endpoints above.
  app.get("/v1/ops/transactions", async (request: FastifyRequest<{ Querystring: { limit?: string } }>, reply) => {
    const parsed = request.query.limit ? parseInt(request.query.limit, 10) : 20;
    const limit = Number.isNaN(parsed) ? 20 : Math.min(Math.max(parsed, 1), 100);
    const jobs = await getRecentJobsForTeam(supabase, request.teamId!, limit);
    return reply.send({
      transactions: jobs
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
