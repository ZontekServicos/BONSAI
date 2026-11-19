import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";

// A single connection holds the migration lock across every migration.
export async function migrate(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(72106401)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const name of [
      "schema.sql",
      "migrations/0002_runtime.sql",
      "migrations/0003_search.sql",
      "migrations/0004_papeis_modalidades.sql",
      "migrations/0005_cadastro_aluno.sql",
      "migrations/0006_ajustes_ficha_professor.sql",
      "migrations/0007_convites.sql",
      "migrations/0008_perfil_aluno.sql",
    ]) {
      const raw = await readFile(resolve("database", name), "utf8");
      const checksum = createHash("sha256").update(raw.replace(/\r\n/g, "\n")).digest("hex");
      const exists = (
        await client.query("SELECT checksum FROM schema_migrations WHERE name=$1", [name])
      ).rows[0];
      if (exists) {
        if (exists.checksum !== checksum) throw new Error(`Migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(raw.replace(/^BEGIN;\s*$/m, "").replace(/^COMMIT;\s*$/m, ""));
        await client.query("INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)", [
          name,
          checksum,
        ]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
      console.info(`Applied ${name}`);
    }
  } finally {
    await client.end();
  }
}
await migrate();
