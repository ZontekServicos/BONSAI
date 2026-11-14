import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import {
  route,
  date,
  positiveMoney,
  text,
  page,
  range,
  paginate,
  fail,
  type Context,
} from "../http.js";

export function reportRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  route(
    app,
    ctx,
    "GET",
    "/caixa/lancamentos",
    {
      role: "admin",
      query: z.strictObject({
        ...page,
        ...range,
        tipo: z.enum(["entrada", "saida"]).optional(),
        categoria: z.enum(["mensalidade", "loja", "sangria", "outros"]).optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT * FROM cash_flow
    WHERE ($1::date IS NULL OR data>=($1::timestamp AT TIME ZONE 'America/Sao_Paulo')) AND ($2::date IS NULL OR data<(($2::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($3::cash_flow_tipo IS NULL OR tipo=$3) AND ($4::cash_flow_categoria IS NULL OR categoria=$4) ORDER BY data DESC,transaction_id`,
        [q.de ?? null, q.ate ?? null, q.tipo ?? null, q.categoria ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "POST",
    "/caixa/sangrias",
    { role: "admin", body: z.strictObject({ valor: positiveMoney, motivo: text(255) }) },
    async (r, reply, b) =>
      reply
        .code(201)
        .send(
          await one(
            db,
            `INSERT INTO cash_flow(tipo,valor,motivo,categoria,registrado_por) VALUES('saida',$1,$2,'sangria',$3) RETURNING *`,
            [b.valor, b.motivo, r.account.id],
          ),
        ),
  );
  route(
    app,
    ctx,
    "POST",
    "/caixa/lancamentos",
    {
      role: "admin",
      body: z.strictObject({
        tipo: z.enum(["entrada", "saida"]),
        valor: positiveMoney,
        motivo: text(255),
      }),
    },
    async (r, reply, b) =>
      reply
        .code(201)
        .send(
          await one(
            db,
            `INSERT INTO cash_flow(tipo,valor,motivo,categoria,registrado_por) VALUES($1,$2,$3,'outros',$4) RETURNING *`,
            [b.tipo, b.valor, b.motivo, r.account.id],
          ),
        ),
  );
  route(
    app,
    ctx,
    "GET",
    "/caixa/balanco",
    { role: "admin", query: z.strictObject({ dia: date.optional() }) },
    (_r, _s, _b, q) =>
      one(db, "SELECT * FROM fn_balanco_diario(coalesce($1::date,fn_hoje_sp()))", [q.dia ?? null]),
  );
  route(
    app,
    ctx,
    "GET",
    "/caixa/balanco/periodo",
    { role: "admin", query: z.strictObject({ de: date, ate: date }) },
    async (_r, _s, _b, q) => {
      const days = (Date.parse(q.ate) - Date.parse(q.de)) / 86400000;
      if (days < 0 || days > 366)
        fail(400, "VALIDATION_ERROR", "Selecione um período de até 367 dias.");
      const base = `SELECT b.* FROM generate_series(0,$2::date-$1::date) n CROSS JOIN LATERAL fn_balanco_diario($1::date+n) b`;
      const dias = (await db.query(`${base} ORDER BY dia`, [q.de, q.ate])).rows;
      const fields = [
        "entradas_mensalidade",
        "entradas_loja",
        "entradas_outros",
        "total_entradas",
        "sangrias",
        "saidas_outros",
        "total_saidas",
        "saldo",
      ];
      const consolidado = await one(
        db,
        `SELECT $1::date AS dia,${fields.map((f) => `sum(${f})::numeric(14,2) AS ${f}`).join(",")},sum(qtd_lancamentos)::int AS qtd_lancamentos FROM (${base}) d`,
        [q.de, q.ate],
      );
      return { dias, consolidado };
    },
  );
  route(app, ctx, "GET", "/dashboard", { role: "admin" }, async () => {
    const row = await one(
      db,
      `SELECT
      (SELECT count(*)::int FROM users WHERE role='aluno' AND status<>'inativo') AS alunos_ativos,
      (SELECT count(*)::int FROM users u WHERE role='aluno' AND status<>'inativo' AND EXISTS
        (SELECT 1 FROM financeiro f WHERE f.user_id=u.id AND f.status<>'pago' AND f.data_vencimento+$1::int<fn_hoje_sp())) AS inadimplentes,
      (SELECT count(*)::int FROM attendance WHERE check_out IS NULL) AS presentes_agora,
      (SELECT coalesce(sum(valor),0)::numeric(14,2) FROM cash_flow WHERE tipo='entrada'
        AND data >= (date_trunc('month',fn_hoje_sp()::timestamp) AT TIME ZONE 'America/Sao_Paulo')
        AND data < ((date_trunc('month',fn_hoje_sp()::timestamp)+interval '1 month') AT TIME ZONE 'America/Sao_Paulo')) AS receita_mes,
      (SELECT saldo FROM fn_balanco_diario(fn_hoje_sp())) AS saldo_hoje`,
      [config.DIAS_CARENCIA],
    );
    return {
      ...row,
      estoque_baixo: (
        await db.query(
          "SELECT * FROM inventory_product WHERE ativo AND estoque_atual<=5 ORDER BY estoque_atual,product_id LIMIT 20",
        )
      ).rows,
    };
  });
}
