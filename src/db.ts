import pg from "pg";
import type { AppConfig } from "./config.js";

export function createPool(config: AppConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000
  });
}

export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query("select 1");
}
