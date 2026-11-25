import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.js";
import { one } from "../db.js";
import type { Config } from "../config.js";
import {
  route,
  uuid,
  date,
  positiveMoney,
  method,
  modality,
  page,
  paginate,
  found,
  fail,
  text,
  STAFF,
  type Context,
} from "../http.js";

/**
 * Painel de gestão ativa (GET /financeiro/mensalidades).
 *
 * Um registro por aluno não inativo, com o status da competência ATUAL
 * (mês corrente em America/Sao_Paulo):
 *   pago     → existe entrada 'mensalidade' no cash_flow ligada (payment_id) a
 *              uma cobrança do aluno com vencimento neste mês;
 *   pendente → não existe (inclusive quando a cobrança do mês nem foi gerada).
 * A competência vem do VENCIMENTO, não da data do lançamento: quitar em
 * novembro a mensalidade atrasada de outubro não torna novembro "pago".
 * Valores: só o gestor recebe `valor` (da cobrança do mês, para a baixa
 * rápida). O professor enxerga status e vencimento, nada mais.
 */
const PAINEL_SQL = `
  WITH ref AS (SELECT date_trunc('month', fn_hoje_sp())::date AS ini),
  alunos AS (
    SELECT u.id AS user_id, u.nome, u.status AS status_aluno, p.modalidade,
           cob.payment_id, cob.valor,
           coalesce(cob.data_vencimento,
             -- sem cobrança gerada: vencimento previsto pelo dia padrão de cobrança
             (ref.ini + (least($1::int, extract(day FROM ref.ini + interval '1 month - 1 day')::int) - 1))
           ) AS data_vencimento,
           (cob.payment_id IS NOT NULL) AS cobranca_gerada,
           pago.data AS pago_em,
           CASE WHEN pago.transaction_id IS NULL THEN 'pendente' ELSE 'pago' END AS status
      FROM users u
      JOIN aluno_profile p ON p.user_id = u.id
      CROSS JOIN ref
      LEFT JOIN LATERAL (
        SELECT f.payment_id, f.data_vencimento, f.valor FROM financeiro f
         WHERE f.user_id = u.id
           AND f.data_vencimento >= ref.ini AND f.data_vencimento < ref.ini + interval '1 month'
         ORDER BY f.data_vencimento, f.payment_id LIMIT 1
      ) cob ON true
      LEFT JOIN LATERAL (
        SELECT c.transaction_id, c.data FROM cash_flow c
          JOIN financeiro f ON f.payment_id = c.payment_id
         WHERE c.tipo = 'entrada' AND c.categoria = 'mensalidade'
           AND f.user_id = u.id
           AND f.data_vencimento >= ref.ini AND f.data_vencimento < ref.ini + interval '1 month'
         ORDER BY c.data DESC LIMIT 1
      ) pago ON true
     WHERE u.role = 'aluno' AND u.status <> 'inativo'
  )`;

/** Colunas de um item do painel (as mesmas para o gestor e para o aluno). */
const PAINEL_COLUNAS = `user_id, nome, status_aluno, modalidade, payment_id,
       to_char(data_vencimento, 'YYYY-MM-DD') AS data_vencimento,
       cobranca_gerada, pago_em, status, valor`;

/**
 * Situação do mês atual de UM aluno, com a MESMA consulta do painel do gestor
 * (PAINEL_SQL): o aluno vê exatamente o status que o admin vê, inclusive
 * "pendente" quando a cobrança do mês ainda não foi gerada. null se o aluno
 * não entra no painel (inativo).
 */
export async function situacaoDoMes(db: DB, config: Config, user_id: string) {
  return (
    (await one(
      db,
      `${PAINEL_SQL}
       SELECT to_char((SELECT ini FROM ref), 'YYYY-MM') AS competencia, ${PAINEL_COLUNAS}
         FROM alunos WHERE user_id = $2`,
      [config.BILLING_DUE_DAY, user_id],
    )) ?? null
  );
}

export async function situation(db: DB, id: string, config: Config) {
  const row = await one(db, "SELECT fn_sincronizar_status_aluno($1,$2) AS status", [
    id,
    config.DIAS_CARENCIA,
  ]);
  const pendencias = (
    await db.query("SELECT * FROM fn_pendencias_bloqueantes($1,$2)", [id, config.DIAS_CARENCIA])
  ).rows;
  const total = await one(
    db,
    "SELECT coalesce(sum(valor),0)::numeric(12,2) AS total FROM fn_pendencias_bloqueantes($1,$2)",
    [id, config.DIAS_CARENCIA],
  );
  return {
    status: row.status as "ativo" | "inativo" | "inadimplente",
    pendencias,
    total_devido: total.total as string,
  };
}
export const batchSchema = z.strictObject({
  competencia: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  dia_vencimento: z.number().int().min(1).max(31),
  valor_padrao: positiveMoney,
  modalidade: modality.optional(),
  valores_por_aluno: z
    .array(z.strictObject({ user_id: uuid, valor: positiveMoney }))
    .max(10000)
    .optional(),
});
export async function batch(db: DB, b: z.infer<typeof batchSchema>) {
  // Lock users first: card, payment, batch and cron share one lock order.
  const users = (
    await db.query(
      `SELECT u.id FROM users u JOIN aluno_profile p ON p.user_id=u.id WHERE u.status<>'inativo'
    AND ($1::modalidade IS NULL OR p.modalidade=$1) AND p.data_matricula<($2::date+interval '1 month') ORDER BY u.id FOR UPDATE OF u`,
      [b.modalidade ?? null, `${b.competencia}-01`],
    )
  ).rows;
  const overrides = b.valores_por_aluno ?? [];
  if (new Set(overrides.map((v) => v.user_id)).size !== overrides.length)
    fail(400, "VALIDATION_ERROR", "Aluno duplicado nos valores específicos.");
  const result = await db.query(
    `INSERT INTO financeiro(user_id,valor,data_vencimento,status)
    SELECT u.id,coalesce(o.valor,$2::numeric),d.due,
      CASE WHEN d.due<fn_hoje_sp() THEN 'atrasado'::payment_status ELSE 'pendente'::payment_status END
    FROM users u LEFT JOIN jsonb_to_recordset($3::jsonb) AS o(user_id uuid,valor numeric) ON o.user_id=u.id
    CROSS JOIN (SELECT (date_trunc('month',$4::date)+make_interval(days=>least($5::int,extract(day FROM ($4::date+interval '1 month - 1 day'))::int)-1))::date AS due) d
    WHERE u.id=ANY($1::uuid[]) ON CONFLICT(user_id,data_vencimento) DO NOTHING RETURNING payment_id`,
    [
      users.map((u) => u.id),
      b.valor_padrao,
      JSON.stringify(overrides),
      `${b.competencia}-01`,
      b.dia_vencimento,
    ],
  );
  return { criadas: result.rows.length, ignoradas: users.length - result.rows.length };
}
export async function generateMonths(
  db: DB,
  id: string,
  b: { valor: string; dia_vencimento: number; meses: number },
) {
  await db.query(
    `INSERT INTO financeiro(user_id,valor,data_vencimento,status)
    SELECT $1,$2,due,CASE WHEN due<fn_hoje_sp() THEN 'atrasado'::payment_status ELSE 'pendente'::payment_status END
    FROM (SELECT (m+make_interval(days=>least($3::int,extract(day FROM (m+interval '1 month - 1 day'))::int)-1))::date AS due
      FROM aluno_profile p CROSS JOIN LATERAL generate_series(date_trunc('month',p.data_matricula),date_trunc('month',p.data_matricula)+make_interval(months=>$4::int-1),interval '1 month') m WHERE p.user_id=$1) dates
    ON CONFLICT(user_id,data_vencimento) DO NOTHING`,
    [id, b.valor, b.dia_vencimento, b.meses],
  );
}
async function paymentLock(db: DB, id: string) {
  const p = found(await one(db, "SELECT user_id FROM financeiro WHERE payment_id=$1", [id]));
  await db.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [p.user_id]);
  return found(await one(db, "SELECT * FROM financeiro WHERE payment_id=$1 FOR UPDATE", [id]));
}
/**
 * Quita uma cobrança: marca `financeiro` como paga E lança a entrada
 * 'mensalidade' no cash_flow. Deve rodar DENTRO de db.transaction: as duas
 * escritas confirmam juntas ou nenhuma confirma.
 *
 * Duplicidade: o lock (aluno → cobrança, FOR UPDATE) serializa baixas
 * simultâneas; a segunda encontra a cobrança já paga e recebe 409. Por baixo
 * disso, cash_flow.payment_id é UNIQUE no banco.
 *
 * `valor_recebido`: o que entrou no caixa. Se omitido, é o valor da cobrança.
 * O valor cobrado em `financeiro` não muda (fica o histórico do que foi cobrado).
 */
async function quitar(
  tx: DB,
  config: Config,
  b: {
    payment_id: string;
    metodo_pagamento: z.infer<typeof method>;
    data_pagamento?: string;
    valor_recebido?: string;
    registrado_por: string;
  },
) {
  const old = await paymentLock(tx, b.payment_id);
  if (old.status === "pago") fail(409, "MENSALIDADE_JA_PAGA", "Mensalidade já paga.");
  // Defesa extra: cobrança "em aberto" que já tem entrada no caixa (não deveria
  // existir) também não recebe um segundo lançamento.
  if (await one(tx, "SELECT 1 FROM cash_flow WHERE payment_id=$1", [b.payment_id]))
    fail(409, "MENSALIDADE_JA_PAGA", "Esta cobrança já tem entrada no caixa.");
  const valid = await one(tx, "SELECT coalesce($1::date,fn_hoje_sp())<=fn_hoje_sp() AS ok", [
    b.data_pagamento ?? null,
  ]);
  if (!valid.ok) fail(400, "VALIDATION_ERROR", "Pagamento não pode ter data futura.");
  const mensalidade = await one(
    tx,
    `UPDATE financeiro SET status='pago',data_pagamento=coalesce($2::date,fn_hoje_sp()),metodo_pagamento=$3
      WHERE payment_id=$1 AND status<>'pago' RETURNING *`,
    [b.payment_id, b.data_pagamento ?? null, b.metodo_pagamento],
  );
  // `valor` de numeric(10,2) chega como string "150.00"; o schema da rota
  // garante o mesmo formato para valor_recebido, então a comparação é exata.
  const valor: string = b.valor_recebido ?? mensalidade.valor;
  const motivo =
    `Mensalidade ${b.payment_id}` +
    (valor !== mensalidade.valor ? ` (cobrado ${mensalidade.valor})` : "");
  const lancamento = await one(
    tx,
    `INSERT INTO cash_flow(tipo,valor,motivo,categoria,payment_id,registrado_por)
      VALUES('entrada',$1,$2,'mensalidade',$3,$4) RETURNING *`,
    [valor, motivo, b.payment_id, b.registrado_por],
  );
  const s = await situation(tx, old.user_id, config);
  return { mensalidade, lancamento, status_aluno: s.status };
}
export function billingRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const params = z.strictObject({ payment_id: uuid });
  route(
    app,
    ctx,
    "GET",
    "/mensalidades",
    {
      role: "admin",
      query: z.strictObject({
        ...page,
        user_id: uuid.optional(),
        status: z.enum(["pago", "pendente", "atrasado"]).optional(),
        vencimento_de: date.optional(),
        vencimento_ate: date.optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT f.*,u.nome,
    CASE WHEN f.status<>'pago' AND f.data_vencimento<fn_hoje_sp() THEN 'atrasado'::payment_status ELSE f.status END AS status
    FROM financeiro f JOIN users u ON u.id=f.user_id WHERE ($1::uuid IS NULL OR f.user_id=$1)
    AND ($2::text IS NULL OR (CASE WHEN f.status<>'pago' AND f.data_vencimento<fn_hoje_sp() THEN 'atrasado' ELSE f.status::text END)=$2)
    AND ($3::date IS NULL OR f.data_vencimento >= $3) AND ($4::date IS NULL OR f.data_vencimento <= $4) ORDER BY f.data_vencimento DESC,f.payment_id`,
        [q.user_id ?? null, q.status ?? null, q.vencimento_de ?? null, q.vencimento_ate ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "POST",
    "/mensalidades",
    {
      role: "admin",
      body: z.strictObject({ user_id: uuid, valor: positiveMoney, data_vencimento: date }),
    },
    async (_r, reply, b) => {
      const result = await db.transaction(async (tx) => {
        found(
          await one(tx, "SELECT id FROM users WHERE id=$1 AND role='aluno' FOR UPDATE", [
            b.user_id,
          ]),
        );
        const row = await one(
          tx,
          `INSERT INTO financeiro(user_id,valor,data_vencimento,status) VALUES($1,$2,$3,
        CASE WHEN $3::date<fn_hoje_sp() THEN 'atrasado'::payment_status ELSE 'pendente'::payment_status END) RETURNING *`,
          [b.user_id, b.valor, b.data_vencimento],
        );
        await situation(tx, b.user_id, config);
        return row;
      });
      return reply.code(201).send(result);
    },
  );
  route(
    app,
    ctx,
    "POST",
    "/mensalidades/lote",
    { role: "admin", body: batchSchema },
    async (_r, reply, b) => reply.code(201).send(await db.transaction((tx) => batch(tx, b))),
  );
  route(
    app,
    ctx,
    "PATCH",
    "/mensalidades/:payment_id",
    {
      role: "admin",
      params,
      body: z
        .strictObject({ valor: positiveMoney.optional(), data_vencimento: date.optional() })
        .refine((v) => Object.keys(v).length > 0),
    },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        const old = await paymentLock(tx, p.payment_id);
        if (old.status === "pago") fail(409, "MENSALIDADE_JA_PAGA", "Mensalidade já paga.");
        const row = await one(
          tx,
          `UPDATE financeiro SET valor=coalesce($2,valor),data_vencimento=coalesce($3::date,data_vencimento),
      status=CASE WHEN coalesce($3::date,data_vencimento)<fn_hoje_sp() THEN 'atrasado'::payment_status ELSE 'pendente'::payment_status END WHERE payment_id=$1 RETURNING *`,
          [p.payment_id, b.valor ?? null, b.data_vencimento ?? null],
        );
        await situation(tx, old.user_id, config);
        return row;
      }),
  );
  route(
    app,
    ctx,
    "PATCH",
    "/mensalidades/:payment_id/pagar",
    {
      role: "admin",
      params,
      body: z.strictObject({ metodo_pagamento: method, data_pagamento: date.optional() }),
    },
    async (r, _s, b, _q, p) =>
      db.transaction((tx) =>
        quitar(tx, config, { ...b, payment_id: p.payment_id, registrado_por: r.account.id }),
      ),
  );
  // Baixa rápida (painel de mensalidades): só o gestor. Mesma transação de
  // PATCH /mensalidades/:id/pagar, com o valor efetivamente recebido.
  route(
    app,
    ctx,
    "POST",
    "/financeiro/baixa",
    {
      role: "admin",
      body: z.strictObject({
        payment_id: uuid,
        valor_pago: positiveMoney,
        metodo_pagamento: method.default("pix"),
      }),
    },
    async (r, reply, b) =>
      reply.code(201).send(
        await db.transaction((tx) =>
          quitar(tx, config, {
            payment_id: b.payment_id,
            metodo_pagamento: b.metodo_pagamento,
            valor_recebido: b.valor_pago,
            registrado_por: r.account.id,
          }),
        ),
      ),
  );
  route(
    app,
    ctx,
    "DELETE",
    "/mensalidades/:payment_id",
    { role: "admin", params },
    async (_r, reply, _b, _q, p) => {
      await db.transaction(async (tx) => {
        const old = await paymentLock(tx, p.payment_id);
        if (old.status === "pago") fail(409, "MENSALIDADE_JA_PAGA", "Mensalidade já paga.");
        await tx.query("DELETE FROM financeiro WHERE payment_id=$1", [p.payment_id]);
        await situation(tx, old.user_id, config);
      });
      return reply.code(204).send();
    },
  );
  route(
    app,
    ctx,
    "GET",
    "/financeiro/inadimplentes",
    { role: "admin" },
    async () =>
      (
        await db.query(
          `SELECT u.id AS user_id,u.nome,sum(f.valor)::numeric(12,2) AS total_devido,min(f.data_vencimento) AS mais_antiga,
    (fn_hoje_sp()-min(f.data_vencimento))::int AS dias_atraso FROM users u JOIN financeiro f ON f.user_id=u.id
    WHERE u.status<>'inativo' AND f.status<>'pago' AND f.data_vencimento+$1::int<fn_hoje_sp() GROUP BY u.id ORDER BY mais_antiga`,
          [config.DIAS_CARENCIA],
        )
      ).rows,
  );
  route(
    app,
    ctx,
    "GET",
    "/financeiro/resumo",
    { role: "admin", query: z.strictObject({ competencia: batchSchema.shape.competencia }) },
    async (_r, _s, _b, q) =>
      one(
        db,
        // recebido = o que entrou no caixa (a baixa rápida pode receber valor
        // diferente do cobrado); cash_flow.payment_id é UNIQUE, o JOIN não duplica.
        `SELECT coalesce(sum(f.valor),0)::numeric(12,2) AS previsto,
    coalesce(sum(coalesce(c.valor,f.valor)) FILTER(WHERE f.status='pago'),0)::numeric(12,2) AS recebido,
    coalesce(sum(f.valor) FILTER(WHERE f.status<>'pago'),0)::numeric(12,2) AS em_aberto,
    coalesce(sum(f.valor) FILTER(WHERE f.status<>'pago' AND f.data_vencimento<fn_hoje_sp()),0)::numeric(12,2) AS atrasado,
    coalesce(round(100.0*count(*) FILTER(WHERE f.status<>'pago' AND f.data_vencimento<fn_hoje_sp())/nullif(count(*),0),2),0)::text AS taxa_inadimplencia
    FROM financeiro f LEFT JOIN cash_flow c ON c.payment_id=f.payment_id
    WHERE f.data_vencimento >= $1::date AND f.data_vencimento < $1::date+interval '1 month'`,
        [`${q.competencia}-01`],
      ),
  );

  route(
    app,
    ctx,
    "GET",
    "/financeiro/mensalidades",
    {
      role: STAFF,
      query: z.strictObject({
        ...page,
        // aceita ?status=pendente ou ?status=PENDENTE
        status: z.preprocess(
          (v) => (typeof v === "string" ? v.toLowerCase() : v),
          z.enum(["pago", "pendente"]).optional(),
        ),
        q: text().optional(),
      }),
    },
    async (r, _s, _b, q) => {
      const lista = await paginate(
        db,
        `${PAINEL_SQL}
         SELECT ${PAINEL_COLUNAS}
           FROM alunos
          WHERE ($2::text IS NULL OR status = $2)
            AND ($3::text IS NULL OR nome ILIKE '%'||$3||'%')
          ORDER BY (status = 'pendente') DESC, data_vencimento, nome, user_id`,
        [config.BILLING_DUE_DAY, q.status ?? null, q.q ?? null],
        { page: q.page, page_size: q.page_size },
      );
      // Contadores para as abas (independem do filtro de status).
      const resumo = await one(
        db,
        `${PAINEL_SQL}
         SELECT to_char((SELECT ini FROM ref), 'YYYY-MM') AS competencia,
                count(*)::int AS todos,
                count(*) FILTER (WHERE status = 'pago')::int AS pago,
                count(*) FILTER (WHERE status = 'pendente')::int AS pendente
           FROM alunos WHERE ($2::text IS NULL OR nome ILIKE '%'||$2||'%')`,
        [config.BILLING_DUE_DAY, q.q ?? null],
      );
      const { competencia, ...contagem } = resumo;
      // Valores só para o gestor; para o professor os campos nem aparecem.
      if (r.account.role === "admin")
        return {
          ...lista,
          competencia,
          resumo: contagem,
          // sugestão para "Gerar cobrança" quando o mês ainda não tem cobrança
          valor_padrao: config.BILLING_AMOUNT,
        };
      const data = lista.data.map(({ valor: _valor, ...item }: Record<string, unknown>) => item);
      return { ...lista, data, competencia, resumo: contagem };
    },
  );
}
