import "dotenv/config";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import { createLogger } from "../lib/logger.js";
import { loadConfig } from "../lib/config.js";

const config = loadConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config, log);

async function main() {
  await migrate(pool, log);
  log.info("Migrations complete");
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "Migration failed");
  process.exit(1);
});
