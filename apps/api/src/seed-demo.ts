/**
 * Contas de demonstração para testar o controle de acesso (RBAC).
 *
 *   pnpm demo:seed
 *
 * Cria (ou redefine) dois usuários reais no banco, com senha em Argon2id:
 *   - Professor (role admin)
 *   - Aluno (role aluno), com perfil e a mensalidade do mês paga, para
 *     que a carteirinha fique liberada.
 *
 * O login segue o fluxo normal da API (JWT + refresh); nada é validado no
 * navegador. O script se recusa a rodar com NODE_ENV=production e não entra
 * no build da API (build:api), então não vai para o Railway.
 */
import pg from "pg";
import { hashPassword } from "./auth.js";
import { DEMO_ACCOUNTS } from "../../../src/lib/demo-accounts.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("demo:seed não pode rodar com NODE_ENV=production.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const { professor, aluno } = DEMO_ACCOUNTS;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const upsertUser = `
  INSERT INTO users(nome, email, password_hash, role, status)
  VALUES ($1, $2, $3, $4, 'ativo')
  ON CONFLICT (email) DO UPDATE
     SET nome = EXCLUDED.nome,
         password_hash = EXCLUDED.password_hash,
         status = 'ativo'
   WHERE users.role = EXCLUDED.role
  RETURNING id`;

try {
  await client.query("BEGIN");

  const admin = await client.query(upsertUser, [
    professor.nome,
    professor.email,
    await hashPassword(professor.password),
    "admin",
  ]);
  const student = await client.query(upsertUser, [
    aluno.nome,
    aluno.email,
    await hashPassword(aluno.password),
    "aluno",
  ]);
  if (!admin.rows[0] || !student.rows[0]) {
    throw new Error("Um dos e-mails de demonstração já existe com outro papel (role).");
  }
  const adminId: string = admin.rows[0].id;
  const alunoId: string = student.rows[0].id;

  // Senha redefinida ⇒ sessões antigas dessas contas deixam de valer.
  await client.query(
    "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = ANY($1) AND revoked_at IS NULL",
    [[adminId, alunoId]],
  );

  await client.query(
    `INSERT INTO aluno_profile(user_id, modalidade, faixa, graduacao_nivel)
     VALUES ($1, 'jiu_jitsu', 'azul', 2)
     ON CONFLICT (user_id) DO NOTHING`,
    [alunoId],
  );

  // Mensalidade do mês corrente paga (+ lançamento no caixa), para a carteirinha liberar.
  const paid = await client.query(
    `INSERT INTO financeiro(user_id, valor, data_vencimento, data_pagamento, status, metodo_pagamento)
     VALUES ($1, 150.00, date_trunc('month', fn_hoje_sp())::date + 9, fn_hoje_sp(), 'pago', 'pix')
     ON CONFLICT (user_id, data_vencimento) DO NOTHING
     RETURNING payment_id, valor`,
    [alunoId],
  );
  if (paid.rows[0]) {
    await client.query(
      `INSERT INTO cash_flow(tipo, valor, motivo, categoria, payment_id, registrado_por)
       VALUES ('entrada', $1, 'Mensalidade (demonstração)', 'mensalidade', $2, $3)`,
      [paid.rows[0].valor, paid.rows[0].payment_id, adminId],
    );
  }
  await client.query("SELECT fn_sincronizar_status_aluno($1, 5)", [alunoId]);

  await client.query("COMMIT");
  console.info("Contas de demonstração prontas:");
  console.info(`  Professor (admin): ${professor.email} / ${professor.password}`);
  console.info(`  Aluno:             ${aluno.email} / ${aluno.password}`);
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
