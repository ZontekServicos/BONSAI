import { readConfig } from "../config.js";
import { createDatabase } from "../db.js";
import { daily } from "./service.js";
const config = readConfig();
const db = createDatabase(config);
try {
  console.info(JSON.stringify(await daily(db, config)));
} finally {
  await db.close();
}
