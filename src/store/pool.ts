import pg from "pg";
import type { Config } from "../lib/config.js";
import type { Logger } from "../lib/logger.js";

const { Pool } = pg;

export function createPool(config: Config, log: Logger): pg.Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => log.error({ err }, "Postgres pool error"));
  return pool;
}
