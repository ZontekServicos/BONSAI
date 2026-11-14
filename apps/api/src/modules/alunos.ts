import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { alunoSQL, one, type DB } from "../db.js";
import {
  route,
  modality,
  text,
  uuid,
  date,
  positiveMoney,
  page,
  range,
  paginate,
  found,
  fail,
  selfOrAdmin,
  type Context,
} from "../http.js";
import { hashPassword } from "../auth.js";
import { generateMonths, situation } from "./billing.js";

export async function aluno(db: DB, id: string) {
  return found(await one(db, `${alunoSQL} WHERE u.id=$1`, [id]));
}
export function alunosRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const params = z.strictObject({ id: uuid });
  route(
    app,
    ctx,
    "GET",
    "/alunos",
    {
      role: "admin",
      query: z.strictObject({
        ...page,
        q: text().optional(),
        modalidade: modality.optional(),
        status: z.enum(["ativo", "inativo", "inadimplente"]).optional(),
        faixa: text(40).optional(),
        sort: z.enum(["nome", "data_matricula"]).default("nome"),
      }),
    },
    async (_r, _s, _b, q) =>
      paginate(
        db,
        `${alunoSQL} WHERE ($1::text IS NULL OR u.nome ILIKE '%'||$1||'%' OR u.email::text ILIKE '%'||$1||'%')
      AND ($2::modalidade IS NULL OR p.modalidade=$2) AND ($3::user_status IS NULL OR u.status=$3)
      AND ($4::text IS NULL OR p.faixa=$4) ORDER BY ${q.sort === "nome" ? "u.nome" : "p.data_matricula"},u.id`,
        [q.q ?? null, q.modalidade ?? null, q.status ?? null, q.faixa ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "POST",
    "/alunos",
    {
      role: "admin",
      body: z.strictObject({
        nome: text().min(2),
        email: z.email().max(254),
        senha_inicial: z.string().min(8).max(128),
        modalidade: modality,
        faixa: text(40),
        graduacao_nivel: z.number().int().min(0).max(20).default(0),
        data_matricula: date.optional(),
        gerar_mensalidades: z
          .strictObject({
            valor: positiveMoney,
            dia_vencimento: z.number().int().min(1).max(31),
            meses: z.number().int().min(1).max(24),
          })
          .optional(),
      }),
    },
    async (_r, reply, b) => {
      const password = await hashPassword(b.senha_inicial);
      const result = await db.transaction(async (tx) => {
        const user = await one(
          tx,
          `INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,'aluno') RETURNING id`,
          [b.nome, b.email, password],
        );
        await tx.query(
          `INSERT INTO aluno_profile(user_id,modalidade,faixa,graduacao_nivel,data_matricula)
        VALUES($1,$2,$3,$4,coalesce($5::date,fn_hoje_sp()))`,
          [user.id, b.modalidade, b.faixa, b.graduacao_nivel, b.data_matricula ?? null],
        );
        if (b.gerar_mensalidades) await generateMonths(tx, user.id, b.gerar_mensalidades);
        return aluno(tx, user.id);
      });
      return reply.code(201).send(result);
    },
  );
  route(app, ctx, "GET", "/alunos/:id", { params }, async (r, _s, _b, _q, p) => {
    selfOrAdmin(r, p.id);
    return db.transaction(async (tx) => {
      const s = await situation(tx, p.id, config);
      return { ...(await aluno(tx, p.id)), situacao_financeira: s };
    });
  });
  route(
    app,
    ctx,
    "PATCH",
    "/alunos/:id",
    {
      role: "admin",
      params,
      body: z
        .strictObject({
          nome: text().min(2).optional(),
          email: z.email().max(254).optional(),
          modalidade: modality.optional(),
        })
        .refine((b) => Object.keys(b).length > 0),
    },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        found(
          await one(tx, "SELECT id FROM users WHERE id=$1 AND role='aluno' FOR UPDATE", [p.id]),
        );
        await tx.query(
          "UPDATE users SET nome=coalesce($2,nome),email=coalesce($3,email) WHERE id=$1",
          [p.id, b.nome ?? null, b.email ?? null],
        );
        await tx.query(
          "UPDATE aluno_profile SET modalidade=coalesce($2,modalidade) WHERE user_id=$1",
          [p.id, b.modalidade ?? null],
        );
        return aluno(tx, p.id);
      }),
  );
  route(
    app,
    ctx,
    "PATCH",
    "/alunos/:id/status",
    { role: "admin", params, body: z.strictObject({ status: z.enum(["ativo", "inativo"]) }) },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        found(
          await one(tx, "UPDATE users SET status=$2 WHERE id=$1 AND role='aluno' RETURNING id", [
            p.id,
            b.status,
          ]),
        );
        if (b.status === "inativo")
          await tx.query(
            "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
            [p.id],
          );
        else await situation(tx, p.id, config);
        return aluno(tx, p.id);
      }),
  );
  const history = (id: string) =>
    db
      .query("SELECT * FROM graduacao_historico WHERE user_id=$1 ORDER BY data_graduacao DESC,id", [
        id,
      ])
      .then((r) => r.rows);
  route(app, ctx, "GET", "/alunos/:id/graduacoes", { params }, async (r, _s, _b, _q, p) => {
    selfOrAdmin(r, p.id);
    await aluno(db, p.id);
    return history(p.id);
  });
  route(
    app,
    ctx,
    "POST",
    "/alunos/:id/graduacoes",
    {
      role: "admin",
      params,
      body: z.strictObject({
        faixa_nova: text(40),
        graduacao_nova: z.number().int().min(0).max(20),
        data_graduacao: date.optional(),
        observacao: text(2000).optional(),
      }),
    },
    async (r, reply, b, _q, p) => {
      const result = await db.transaction(async (tx) => {
        found(
          await one(tx, "SELECT id FROM users WHERE id=$1 AND role='aluno' FOR UPDATE", [p.id]),
        );
        const old = found(
          await one(tx, "SELECT * FROM aluno_profile WHERE user_id=$1 FOR UPDATE", [p.id]),
        );
        const row = await one(
          tx,
          `INSERT INTO graduacao_historico(user_id,modalidade,faixa_anterior,graduacao_anterior,faixa_nova,graduacao_nova,data_graduacao,promovido_por,observacao)
        VALUES($1,$2,$3,$4,$5,$6,coalesce($7::date,fn_hoje_sp()),$8,$9) RETURNING *`,
          [
            p.id,
            old.modalidade,
            old.faixa,
            old.graduacao_nivel,
            b.faixa_nova,
            b.graduacao_nova,
            b.data_graduacao ?? null,
            r.account.id,
            b.observacao ?? null,
          ],
        );
        await tx.query("UPDATE aluno_profile SET faixa=$2,graduacao_nivel=$3 WHERE user_id=$1", [
          p.id,
          b.faixa_nova,
          b.graduacao_nova,
        ]);
        return row;
      });
      return reply.code(201).send(result);
    },
  );
  route(app, ctx, "GET", "/me/perfil", { role: "aluno" }, (r) => aluno(db, r.account.id));
  route(app, ctx, "GET", "/me/graduacoes", { role: "aluno" }, (r) => history(r.account.id));
  route(
    app,
    ctx,
    "GET",
    "/me/mensalidades",
    {
      role: "aluno",
      query: z.strictObject({ status: z.enum(["pago", "pendente", "atrasado"]).optional() }),
    },
    async (r, _s, _b, q) =>
      db.transaction(async (tx) => {
        await situation(tx, r.account.id, config);
        return (
          await tx.query(
            "SELECT * FROM financeiro WHERE user_id=$1 AND ($2::payment_status IS NULL OR status=$2) ORDER BY data_vencimento DESC",
            [r.account.id, q.status ?? null],
          )
        ).rows;
      }),
  );
  route(
    app,
    ctx,
    "GET",
    "/me/presencas",
    { role: "aluno", query: z.strictObject({ ...page, ...range }) },
    (r, _s, _b, q) =>
      paginate(
        db,
        `SELECT * FROM attendance WHERE user_id=$1
    AND ($2::date IS NULL OR check_in>=($2::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($3::date IS NULL OR check_in<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')) ORDER BY check_in DESC`,
        [r.account.id, q.de ?? null, q.ate ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "GET",
    "/me/compras",
    { role: "aluno", query: z.strictObject(page) },
    (r, _s, _b, q) =>
      paginate(
        db,
        `SELECT v.*,p.nome AS produto_nome FROM loja_venda v JOIN inventory_product p USING(product_id) WHERE v.user_id=$1 ORDER BY v.data_venda DESC`,
        [r.account.id],
        q,
      ),
  );
}
