import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

async function migrate(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDir = path.resolve(dirname, "../migrations");
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

  try {
    for (const file of files) {
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await pool.query(sql);
      console.log(JSON.stringify({ level: "info", event: "migration.applied", file }));
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(JSON.stringify({ level: "error", event: "migration.failed", error: String(error) }));
  process.exit(1);
});
