import "dotenv/config";
import { createPool } from "./pool.js";
import { migrate } from "./migrate.js";
import { createLogger } from "../lib/logger.js";
import { loadMigrationConfig } from "../lib/config.js";

// Validates only the database and logging variables. Migrations neither sign nor
// broadcast, so demanding FEE_PAYER_SECRET_KEY and the rest here blocked CI and
// every fresh clone — to-be-fixed.md issue 3.
const config = loadMigrationConfig();
const log = createLogger(config.LOG_LEVEL);
const pool = createPool(config, log);

async function main() {
  // migrate() logs its own summary (applied vs skipped), which is the line worth
  // reading now that a run is usually a no-op.
  await migrate(pool, log);
  await pool.end();
}

main().catch((err) => {
  log.error({ err }, "Migration failed");
  process.exit(1);
});
