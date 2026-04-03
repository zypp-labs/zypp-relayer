import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { Logger } from "../lib/logger.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export async function migrate(pool: pg.Pool, log: Logger): Promise<void> {
  const migrationsDir = join(__dirname, "../../migrations");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const path = join(migrationsDir, file);
    const sql = readFileSync(path, "utf-8");
    log.info({ file }, "Running migration");
    await pool.query(sql);
  }
}
