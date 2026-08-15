import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import supabase from "../lib/supabase.js";
import { createQueue, createRedisConnection } from "../queue/index.js";
import { RedisSolBudgetStore } from "../lib/solBudgetStore.js";
import { registerRoutes } from "./routes.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const queue = createQueue(config, log);
  const redis = createRedisConnection(config);

  // Same Redis keyspace the worker writes to, so ingress reads the live window
  // rather than a second, empty one. A separate connection from the rate
  // limiter's: that one is shared with Fastify's plugin and a slow budget read
  // must not sit behind it.
  const policyRedis = createRedisConnection(config);
  const solBudgetStore = new RedisSolBudgetStore(policyRedis);

  const app = Fastify({ loggerInstance: log as any });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
    keyGenerator: (request) => {
      const ip = request.ip;
      return ip ?? "unknown";
    },
  });

  await registerRoutes(app, { supabase, queue, log, intentDomain: config.RELAYER_INTENT_DOMAIN, config, solBudgetStore });

  app.listen({ port: config.PORT, host: "0.0.0.0" }, (err, address) => {
    if (err) {
      log.error({ err }, "Server failed to start");
      process.exit(1);
    }
    log.info({ address }, "API server listening");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
