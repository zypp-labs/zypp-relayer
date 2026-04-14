import { Queue } from "bullmq";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";
import Redis from "ioredis";

const QUEUE_NAME = "zrn-broadcast";

export interface BroadcastJobData {
  jobId: string;
  type?: "transaction" | "intent";
}

function createRedis(config: Config) {
  return new (Redis as any)(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}

export function createQueue(config: Config, log: Logger): Queue<BroadcastJobData> {
  const connection = createRedis(config);
  const queue = new Queue<BroadcastJobData>(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: config.BULL_MAX_ATTEMPTS,
      backoff: {
        type: "exponential",
        delay: config.BULL_BACKOFF_MS,
      },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    },
  });
  log.info("Queue created");
  return queue;
}

export function createRedisConnection(config: Config) {
  return createRedis(config);
}
