import { readConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { buildApp } from "./app.js";
const config = readConfig();
const db = createDatabase(config);
const app = await buildApp(config, db);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try {
    await app.close();
    await db.close();
    clearTimeout(deadline);
  } catch {
    process.exitCode = 1;
  }
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
try {
  await app.listen({ host: "0.0.0.0", port: config.PORT });
} catch {
  await db.close();
  process.exitCode = 1;
}
