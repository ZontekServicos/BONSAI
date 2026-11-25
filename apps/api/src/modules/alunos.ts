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
  staffOrSelf,
  STAFF,
  type Context,
} from "../http.js";
import { hashPassword } from "../auth.js";
import {
  colunasGraduacao,
  contatoEmergenciaSchema,
  dataMatriculaSchema,
  graduacaoCampos,
  graduacaoSchema,
  modalidadeSchema,
  nivelSchema,
  validarNivelPorModalidade,
} from "../../../../src/lib/cadastro.js";
import { MODALIDADE_COM_FAIXA, type NivelTecnico } from "../../../../src/types/contract.js";

/** Promoção conforme a modalidade atual do aluno (mesma regra do cadastro). */
function validarPromocao(
  modalidade: string,
  b: { faixa_nova?: string; graduacao_nova?: number; nivel_novo?: NivelTecnico },
) {
  if (modalidade === MODALIDADE_COM_FAIXA) {
    if (b.faixa_nova === undefined || b.graduacao_nova === undefined || b.nivel_novo)
      fail(400, "VALIDATION_ERROR", "Jiu-Jitsu: informe faixa_nova e graduacao_nova (sem nível).");
    return colunasGraduacao({
      modalidade: MODALIDADE_COM_FAIXA,
      faixa: b.faixa_nova,
      grau: b.graduacao_nova,
    });
  }
  if (!b.nivel_novo || b.faixa_nova !== undefined || b.graduacao_nova !== undefined)
    fail(
      400,
      "VALIDATION_ERROR",
      "Esta modalidade usa nivel_novo: Iniciante, Intermediário ou Avançado.",
    );
  return colunasGraduacao({ modalidade: "boxe", nivel: b.nivel_novo });
}
import { generateMonths, situacaoDoMes, situation } from "./billing.js";

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
      role: STAFF,
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
      // Cadastro simples (admin). Mesmas regras da ficha para nível por
      // modalidade e contato de emergência obrigatório.
      body: z
        .strictObject({
          nome: text().min(2),
          email: z.email().max(254),
          senha_inicial: z.string().min(8).max(128),
          modalidade: modalidadeSchema,
          ...graduacaoCampos,
          data_matricula: dataMatriculaSchema.optional(),
          contato_emergencia: contatoEmergenciaSchema,
          gerar_mensalidades: z
            .strictObject({
              valor: positiveMoney,
              dia_vencimento: z.number().int().min(1).max(31),
              meses: z.number().int().min(1).max(24),
            })
            .optional(),
        })
        .superRefine((b, ctx) => validarNivelPorModalidade(b, ctx)),
    },
    async (_r, reply, b) => {
      const password = await hashPassword(b.senha_inicial);
      const g = colunasGraduacao(b);
      const e = b.contato_emergencia;
      const result = await db.transaction(async (tx) => {
        const user = await one(
          tx,
          `INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,'aluno') RETURNING id`,
          [b.nome, b.email, password],
        );
        await tx.query(
          `INSERT INTO aluno_profile(user_id,modalidade,faixa,graduacao_nivel,nivel,data_matricula,
             contato_emergencia_nome,contato_emergencia_parentesco,contato_emergencia_telefone,
             contato_emergencia_telefone2)
        VALUES($1,$2,$3,$4,$5,coalesce($6::date,fn_hoje_sp()),$7,$8,$9,$10)`,
          [
            user.id,
            b.modalidade,
            g.faixa,
            g.graduacao_nivel,
            g.nivel,
            b.data_matricula ?? null,
            e.nome,
            e.parentesco,
            e.telefone,
            e.telefone2,
          ],
        );
        if (b.gerar_mensalidades) await generateMonths(tx, user.id, b.gerar_mensalidades);
        return aluno(tx, user.id);
      });
      return reply.code(201).send(result);
    },
  );
  route(app, ctx, "GET", "/alunos/:id", { params }, async (r, _s, _b, _q, p) => {
    staffOrSelf(r, p.id);
    // Professor vê o cadastro, mas não a situação financeira.
    if (r.account.role === "professor") return aluno(db, p.id);
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
          modalidade: modalidadeSchema.optional(),
          // Só junto com a troca de modalidade (promoção é em /graduacoes).
          ...graduacaoCampos,
        })
        .refine((b) => Object.keys(b).length > 0),
    },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        found(
          await one(tx, "SELECT id FROM users WHERE id=$1 AND role='aluno' FOR UPDATE", [p.id]),
        );
        const atual = found(
          await one(tx, "SELECT modalidade FROM aluno_profile WHERE user_id=$1 FOR UPDATE", [p.id]),
        );
        const trocou = b.modalidade !== undefined && b.modalidade !== atual.modalidade;
        const { nome, email, modalidade, ...grad } = b;
        if (!trocou && Object.values(grad).some((v) => v !== undefined))
          fail(
            400,
            "VALIDATION_ERROR",
            "Faixa, grau e nível só mudam junto com a modalidade; promoções vão em /graduacoes.",
          );
        await tx.query(
          "UPDATE users SET nome=coalesce($2,nome),email=coalesce($3,email) WHERE id=$1",
          [p.id, nome ?? null, email ?? null],
        );
        if (trocou) {
          // Nova modalidade ⇒ nova graduação, com a mesma regra do cadastro.
          const parsed = graduacaoSchema.safeParse({ modalidade, ...grad });
          if (!parsed.success)
            fail(
              400,
              "VALIDATION_ERROR",
              "Graduação incompatível com a nova modalidade.",
              parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
            );
          const g = colunasGraduacao(parsed.data);
          await tx.query(
            `UPDATE aluno_profile SET modalidade=$2,faixa=$3,graduacao_nivel=$4,nivel=$5
              WHERE user_id=$1`,
            [p.id, parsed.data.modalidade, g.faixa, g.graduacao_nivel, g.nivel],
          );
        }
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
    staffOrSelf(r, p.id);
    await aluno(db, p.id);
    return history(p.id);
  });
  route(
    app,
    ctx,
    "POST",
    "/alunos/:id/graduacoes",
    {
      role: STAFF,
      params,
      // Jiu-Jitsu: faixa_nova + graduacao_nova. Demais modalidades: nivel_novo.
      body: z.strictObject({
        faixa_nova: text(40).optional(),
        graduacao_nova: z.number().int().min(0).max(20).optional(),
        nivel_novo: nivelSchema.optional(),
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
        const g = validarPromocao(old.modalidade, b);
        const row = await one(
          tx,
          `INSERT INTO graduacao_historico(user_id,modalidade,faixa_anterior,graduacao_anterior,faixa_nova,graduacao_nova,data_graduacao,promovido_por,observacao)
        VALUES($1,$2,$3,$4,$5,$6,coalesce($7::date,fn_hoje_sp()),$8,$9) RETURNING *`,
          [
            p.id,
            old.modalidade,
            old.faixa,
            old.graduacao_nivel,
            g.faixa,
            g.graduacao_nivel,
            b.data_graduacao ?? null,
            r.account.id,
            b.observacao ?? null,
          ],
        );
        await tx.query(
          "UPDATE aluno_profile SET faixa=$2,graduacao_nivel=$3,nivel=$4 WHERE user_id=$1",
          [p.id, g.faixa, g.graduacao_nivel, g.nivel],
        );
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
        // Mesma regra do painel do gestor: "pago" só com a entrada 'mensalidade'
        // no cash_flow. Sem ela a cobrança é pendente (ou atrasada, se venceu),
        // mesmo que financeiro.status diga outra coisa.
        return (
          await tx.query(
            `SELECT * FROM (
               SELECT f.payment_id, f.user_id, f.valor, f.data_vencimento, f.created_at, f.updated_at,
                      CASE WHEN c.transaction_id IS NOT NULL THEN 'pago'
                           WHEN f.data_vencimento < fn_hoje_sp() THEN 'atrasado'
                           ELSE 'pendente' END::payment_status AS status,
                      CASE WHEN c.transaction_id IS NOT NULL THEN f.data_pagamento END AS data_pagamento,
                      CASE WHEN c.transaction_id IS NOT NULL THEN f.metodo_pagamento END AS metodo_pagamento
                 FROM financeiro f
                 LEFT JOIN cash_flow c
                   ON c.payment_id = f.payment_id AND c.tipo = 'entrada' AND c.categoria = 'mensalidade'
                WHERE f.user_id = $1
             ) m
             WHERE ($2::payment_status IS NULL OR m.status = $2)
             ORDER BY m.data_vencimento DESC`,
            [r.account.id, q.status ?? null],
          )
        ).rows;
      }),
  );
  // Situação do mês atual, idêntica à do painel do gestor (situacaoDoMes usa a
  // mesma consulta): aparece "pendente" mesmo sem cobrança gerada no mês.
  route(app, ctx, "GET", "/me/mensalidades/atual", { role: "aluno" }, (r) =>
    situacaoDoMes(db, config, r.account.id),
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
