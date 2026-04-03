import "dotenv/config";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { loadConfig } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import { createPool } from "../store/pool.js";
import { createQueue, createRedisConnection } from "../queue/index.js";
import { registerRoutes } from "./routes.js";

async function main() {
  const config = loadConfig();
  const log = createLogger(config.LOG_LEVEL);
  const pool = createPool(config, log);
  const queue = createQueue(config, log);
  const redis = createRedisConnection(config);

  const app = Fastify({ logger: log });

  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    redis,
    keyGenerator: (request) => {
      const ip = request.ip;
      return ip ?? "unknown";
    },
  });

  await registerRoutes(app, { pool, queue, log });

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
