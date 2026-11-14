import { z } from "zod";
import pg from "pg";
import { hashPassword } from "./auth.js";
const input = z.strictObject({
  email: z.email(),
  nome: z.string().min(2).max(120),
  senha: z.string().min(12).max(128),
});
// Read JSON through stdin to keep the password out of process arguments/history.
let body = "";
for await (const chunk of process.stdin) {
  body += chunk;
  if (body.length > 4096) throw new Error("Input too large");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const data = input.parse(JSON.parse(body));
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,'admin')", [
    data.nome,
    data.email,
    await hashPassword(data.senha),
  ]);
  console.info("Administrador criado.");
} finally {
  await client.end();
}
