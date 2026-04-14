import "dotenv/config";
import { Worker, Job } from "bullmq";
import Redis from "ioredis";
import { loadConfig } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import supabase from "../lib/supabase.js";
import { getJobById, markJobConfirmed, markJobFailed, incrementJobRetry } from "../store/jobs.js";
import { broadcastWithFailover, processIntentAndBroadcast } from "./broadcast.js";
import type { BroadcastJobData } from "../queue/index.js";
import { isTerminalStatus } from "../lib/constants.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);

  const connection = new (Redis as any)(config.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker<BroadcastJobData>(
    "zrn-broadcast",
    async (job: Job<BroadcastJobData>) => {
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

      let result;
      if (type === "intent") {
        result = await processIntentAndBroadcast(dbJob.payload, config, log);
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
        if (!updated) log.warn({ jobId }, "Could not mark job confirmed (already updated?)");
        return;
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
        result.rpcEndpoint ?? null
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
