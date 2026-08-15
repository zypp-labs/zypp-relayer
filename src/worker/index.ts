import "dotenv/config";
import { Worker, Job, DelayedError } from "bullmq";
import Redis from "ioredis";
import { loadConfig } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import supabase from "../lib/supabase.js";
import { getJobById, markJobConfirmed, markJobFailed, incrementJobRetry } from "../store/jobs.js";
import { broadcastWithFailover, processIntentAndBroadcast, settleLegacyIntent } from "./broadcast.js";
import type { BroadcastJobData } from "../queue/index.js";
import type { IntentEnvelope } from "../lib/feePayer.js";
import { isTerminalStatus } from "../lib/constants.js";
import { RedisVelocityStore } from "../lib/redisVelocityStore.js";
import { RedisSolBudgetStore } from "../lib/solBudgetStore.js";
import { isSolBudgetDeferral, retryAfterSecondsFrom } from "../lib/solBudget.js";
import { createAlertNotifier } from "../lib/alerting.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const connection = new (Redis as any)(config.REDIS_URL, { maxRetriesPerRequest: null });

  // Spend-policy dependencies, built once per process.
  //
  // Both stores live in Redis rather than memory because the worker is not
  // guaranteed to be long-lived: hosts restart on deploy, on scaling, and (on
  // plans with idle suspension) on the first request after a quiet period. An
  // in-memory window is cleared by every one of those, which both forgets real
  // spend during ordinary operation and makes the breaker resettable by anyone
  // who can trigger a restart.
  //
  // A separate connection from the BullMQ one: the queue's connection is
  // configured for blocking commands, and sharing it would let a slow budget
  // read stall job fetching.
  const policyRedis = new (Redis as any)(config.REDIS_URL, { maxRetriesPerRequest: null });
  const velocityStore = new RedisVelocityStore(policyRedis);
  const solBudgetStore = new RedisSolBudgetStore(policyRedis);
  const notifier = createAlertNotifier(config, log);

  const worker = new Worker<BroadcastJobData>(
    "zrn-broadcast",
    async (job: Job<BroadcastJobData>, token?: string) => {
      const { jobId, type } = job.data;
      const dbJob = await getJobById(supabase, jobId);
      if (!dbJob) {
        log.warn({ jobId }, "Job not found in DB, skipping");
        return;
      }
      if (isTerminalStatus(dbJob.status)) {
        log.debug({ jobId, status: dbJob.status }, "Job already terminal, skipping");
        return;
      }
      if (dbJob.degraded) {
        log.debug({ jobId }, "Job flagged as degraded, skipping queue processing");
        return;
      }

      let result;
      if (type === "intent") {
        let intentEnvelope: IntentEnvelope | undefined;
        if (dbJob.intent_envelope) {
          try {
            intentEnvelope = JSON.parse(dbJob.intent_envelope) as IntentEnvelope;
          } catch {
            log.warn({ jobId }, "Failed to parse intent_envelope from DB");
          }
        }

        if (intentEnvelope) {
          // v1 envelope: the client supplied a transaction, and the relayer only
          // co-signs as fee payer after verifying the user's signature over it.
          result = await processIntentAndBroadcast(dbJob.payload, intentEnvelope, config, log, {
            jobId,
            teamId: dbJob.team_id ?? "unknown",
            velocityStore,
            solBudgetStore,
            notifier,
          });
        } else {
          // Legacy bundle: no envelope, no transaction — `payload` is the signed
          // intent JSON itself. This used to fail here with
          // MISSING_INTENT_ENVELOPE, which meant *every* zypp-pay payment was
          // rejected by the worker after being accepted by the API (202 with a
          // jobId, then silence). The relayer now builds the transaction the
          // intent describes, which is what the offline-first model requires:
          // a transaction signed at intent time is dead within ~90 seconds
          // because its blockhash expires (to-be-fixed.md C2).
          result = await settleLegacyIntent(dbJob.payload, config, log, {
            jobId,
            teamId: dbJob.team_id ?? "unknown",
            velocityStore,
            solBudgetStore,
            notifier,
          });
        }
      } else {
        result = await broadcastWithFailover(dbJob.payload, config, log);
      }

      if (result.success) {
        const updated = await markJobConfirmed(
          supabase,
          log,
          jobId,
          result.signature,
          result.rpcEndpoint
        );
        if (!updated) {
          log.warn({ jobId }, "Could not mark job confirmed (already updated?)");
          return;
        }
        return;
      }

      // A SOL budget trip is a deferral, not a failure.
      //
      // The transaction is not defective — the relayer is temporarily out of
      // budget, and the same bytes will settle once the rolling window frees up.
      // Treating it as an ordinary retriable error would burn an attempt each
      // time and exhaust BULL_MAX_ATTEMPTS long before an hour elapsed, turning
      // a temporary limit into a permanent loss of legitimate work.
      //
      // `moveToDelayed` reschedules without consuming an attempt; throwing
      // DelayedError tells BullMQ the handler yielded deliberately rather than
      // crashed. The pair must be used together — moving without throwing lets
      // the worker fall through and complete the job.
      if (isSolBudgetDeferral(result)) {
        const retryAfterMs = Math.max(1, retryAfterSecondsFrom(result)) * 1000;
        log.info(
          { jobId, code: result.failure?.code, retryAfterMs },
          "Deferring job until SOL budget frees",
        );
        await job.moveToDelayed(Date.now() + retryAfterMs, token);
        throw new DelayedError();
      }

      if (result.retriable) {
        await incrementJobRetry(supabase, jobId);
        throw new Error(result.message);
      }

      await markJobFailed(
        supabase,
        log,
        jobId,
        result.message,
        result.rpcEndpoint ?? null,
        result.failure?.stage ?? null,
        result.failure?.code ?? null,
      );
    },
    {
      connection,
      concurrency: config.BULL_CONCURRENCY,
      limiter: {
        max: config.BULL_CONCURRENCY * 2,
        duration: 1000,
      },
    }
  );

  worker.on("completed", (job) => {
    log.debug({ jobId: job.id }, "Job completed");
  });
  worker.on("failed", (job, err) => {
    log.warn({ jobId: job?.id, err: err?.message }, "Job failed");
  });
  worker.on("error", (err) => {
    log.error({ err }, "Worker error");
  });

  log.info({ concurrency: config.BULL_CONCURRENCY }, "Broadcaster worker started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
