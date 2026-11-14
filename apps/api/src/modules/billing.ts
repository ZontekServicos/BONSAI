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
  type Context,
} from "../http.js";

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
      db.transaction(async (tx) => {
        const old = await paymentLock(tx, p.payment_id);
        if (old.status === "pago") fail(409, "MENSALIDADE_JA_PAGA", "Mensalidade já paga.");
        const valid = await one(tx, "SELECT coalesce($1::date,fn_hoje_sp())<=fn_hoje_sp() AS ok", [
          b.data_pagamento ?? null,
        ]);
        if (!valid.ok) fail(400, "VALIDATION_ERROR", "Pagamento não pode ter data futura.");
        const mensalidade = await one(
          tx,
          `UPDATE financeiro SET status='pago',data_pagamento=coalesce($2::date,fn_hoje_sp()),metodo_pagamento=$3
      WHERE payment_id=$1 AND status<>'pago' RETURNING *`,
          [p.payment_id, b.data_pagamento ?? null, b.metodo_pagamento],
        );
        const lancamento = await one(
          tx,
          `INSERT INTO cash_flow(tipo,valor,motivo,categoria,payment_id,registrado_por)
      VALUES('entrada',$1,'Mensalidade '||$2::text,'mensalidade',$2::uuid,$3) RETURNING *`,
          [mensalidade.valor, p.payment_id, r.account.id],
        );
        const s = await situation(tx, old.user_id, config);
        return { mensalidade, lancamento, status_aluno: s.status };
      }),
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
        `SELECT coalesce(sum(valor),0)::numeric(12,2) AS previsto,
    coalesce(sum(valor) FILTER(WHERE status='pago'),0)::numeric(12,2) AS recebido,
    coalesce(sum(valor) FILTER(WHERE status<>'pago'),0)::numeric(12,2) AS em_aberto,
    coalesce(sum(valor) FILTER(WHERE status<>'pago' AND data_vencimento<fn_hoje_sp()),0)::numeric(12,2) AS atrasado,
    coalesce(round(100.0*count(*) FILTER(WHERE status<>'pago' AND data_vencimento<fn_hoje_sp())/nullif(count(*),0),2),0)::text AS taxa_inadimplencia
    FROM financeiro WHERE data_vencimento >= $1::date AND data_vencimento < $1::date+interval '1 month'`,
        [`${q.competencia}-01`],
      ),
  );
}
