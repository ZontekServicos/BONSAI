import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import {
  route,
  uuid,
  text,
  money,
  method,
  page,
  range,
  paginate,
  found,
  fail,
  cents,
  decimal,
  type Context,
} from "../http.js";

export function storeRoutes(app: FastifyInstance, ctx: Context) {
  const { db } = ctx;
  const params = z.strictObject({ id: uuid });
  route(
    app,
    ctx,
    "GET",
    "/produtos",
    {
      query: z.strictObject({
        categoria: text(60).optional(),
        q: text().optional(),
        incluir_inativos: z.enum(["true", "false"]).default("false"),
      }),
    },
    async (r, _s, _b, q) => {
      if (q.incluir_inativos === "true" && r.account.role !== "admin")
        fail(403, "SEM_PERMISSAO", "Acesso não permitido.");
      return (
        await db.query(
          `SELECT * FROM inventory_product WHERE ($1::bool OR ativo) AND ($2::text IS NULL OR categoria=$2) AND ($3::text IS NULL OR nome ILIKE '%'||$3||'%') ORDER BY nome,product_id`,
          [q.incluir_inativos === "true", q.categoria ?? null, q.q ?? null],
        )
      ).rows;
    },
  );
  route(app, ctx, "GET", "/produtos/:id", { params }, async (r, _s, _b, _q, p) =>
    found(
      await one(db, "SELECT * FROM inventory_product WHERE product_id=$1 AND ($2::bool OR ativo)", [
        p.id,
        r.account.role === "admin",
      ]),
    ),
  );
  route(
    app,
    ctx,
    "POST",
    "/produtos",
    {
      role: "admin",
      body: z.strictObject({
        nome: text(),
        preco: money,
        estoque_atual: z.number().int().min(0).max(10000000),
        categoria: text(60),
        descricao: text(2000).nullish(),
      }),
    },
    async (_r, reply, b) =>
      reply
        .code(201)
        .send(
          await one(
            db,
            "INSERT INTO inventory_product(nome,preco,estoque_atual,categoria,descricao) VALUES($1,$2,$3,$4,$5) RETURNING *",
            [b.nome, b.preco, b.estoque_atual, b.categoria, b.descricao ?? null],
          ),
        ),
  );
  route(
    app,
    ctx,
    "PATCH",
    "/produtos/:id",
    {
      role: "admin",
      params,
      body: z
        .strictObject({
          nome: text().optional(),
          preco: money.optional(),
          categoria: text(60).optional(),
          ativo: z.boolean().optional(),
          /** null apaga a descrição */
          descricao: text(2000).nullish(),
        })
        .refine((v) => Object.keys(v).length > 0),
    },
    async (_r, _s, b, _q, p) =>
      found(
        await one(
          db,
          `UPDATE inventory_product SET nome=coalesce($2,nome),preco=coalesce($3,preco),categoria=coalesce($4,categoria),ativo=coalesce($5,ativo),
             descricao=CASE WHEN $6::bool THEN $7 ELSE descricao END WHERE product_id=$1 RETURNING *`,
          [
            p.id,
            b.nome ?? null,
            b.preco ?? null,
            b.categoria ?? null,
            b.ativo ?? null,
            b.descricao !== undefined,
            b.descricao ?? null,
          ],
        ),
      ),
  );
  route(
    app,
    ctx,
    "DELETE",
    "/produtos/:id",
    { role: "admin", params },
    async (_r, reply, _b, _q, p) => {
      found(
        await one(
          db,
          "UPDATE inventory_product SET ativo=false WHERE product_id=$1 RETURNING product_id",
          [p.id],
        ),
      );
      return reply.code(204).send();
    },
  );
  route(
    app,
    ctx,
    "PATCH",
    "/produtos/:id/estoque",
    {
      role: "admin",
      params,
      body: z
        .strictObject({
          operacao: z.enum(["entrada", "ajuste"]),
          quantidade: z.number().int().min(-10000000).max(10000000),
          motivo: text(255),
        })
        .refine((v) => v.operacao !== "entrada" || v.quantidade > 0),
    },
    async (r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        const old = found(
          await one(
            tx,
            "SELECT estoque_atual FROM inventory_product WHERE product_id=$1 FOR UPDATE",
            [p.id],
          ),
        );
        // quantidade is a delta; ajuste accepts negative deltas with an audit reason.
        if (old.estoque_atual + b.quantidade < 0)
          fail(422, "ESTOQUE_INSUFICIENTE", "Ajuste deixaria estoque negativo.");
        const product = await one(
          tx,
          "UPDATE inventory_product SET estoque_atual=estoque_atual+$2 WHERE product_id=$1 RETURNING *",
          [p.id, b.quantidade],
        );
        await tx.query(
          `INSERT INTO inventory_movements(product_id,operacao,quantidade,estoque_anterior,estoque_novo,motivo,registrado_por) VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            p.id,
            b.operacao,
            b.quantidade,
            old.estoque_atual,
            product.estoque_atual,
            b.motivo,
            r.account.id,
          ],
        );
        return product;
      }),
  );
  const saleSchema = z
    .strictObject({
      user_id: uuid,
      metodo_pagamento: method,
      itens: z
        .array(
          z.strictObject({
            product_id: uuid,
            quantidade: z.number().int().min(1).max(100000),
            desconto: money.default("0.00"),
          }),
        )
        .min(1)
        .max(100),
    })
    .refine(
      (v) => new Set(v.itens.map((i) => i.product_id)).size === v.itens.length,
      "Produtos duplicados",
    );
  route(app, ctx, "POST", "/vendas", { role: "admin", body: saleSchema }, async (r, reply, b) => {
    const key = z
      .string()
      .min(8)
      .max(128)
      .regex(/^[\w-]+$/)
      .parse(r.headers["idempotency-key"]);
    b.itens.sort((a, b) => a.product_id.localeCompare(b.product_id));
    const fingerprint = createHash("sha256").update(JSON.stringify(b)).digest("hex");
    const response = await db.transaction(async (tx) => {
      // An advisory transaction lock serializes duplicate requests even before insert.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `${r.account.id}:${key}`,
      ]);
      const existing = await one(
        tx,
        "SELECT *,expires_at>now() AS valid FROM idempotency_keys WHERE actor_id=$1 AND key=$2",
        [r.account.id, key],
      );
      if (existing?.valid) {
        if (existing.request_hash !== fingerprint)
          fail(409, "IDEMPOTENCY_CONFLICT", "Chave já usada com outra venda.");
        return existing.response;
      }
      if (existing)
        await tx.query("DELETE FROM idempotency_keys WHERE actor_id=$1 AND key=$2", [
          r.account.id,
          key,
        ]);
      await tx.query("INSERT INTO idempotency_keys(actor_id,key,request_hash) VALUES($1,$2,$3)", [
        r.account.id,
        key,
        fingerprint,
      ]);
      found(
        await one(tx, "SELECT id FROM users WHERE id=$1 AND role='aluno' FOR UPDATE", [b.user_id]),
      );
      const vendas = [];
      const lancamentos = [];
      let total = 0n;
      for (const item of b.itens) {
        const product = found(
          await one(tx, "SELECT * FROM inventory_product WHERE product_id=$1 FOR UPDATE", [
            item.product_id,
          ]),
        );
        if (!product.ativo) fail(422, "PRODUTO_INATIVO", "Produto inativo.");
        const updated = await one(
          tx,
          "UPDATE inventory_product SET estoque_atual=estoque_atual-$2 WHERE product_id=$1 AND ativo AND estoque_atual >= $2 RETURNING preco",
          [item.product_id, item.quantidade],
        );
        if (!updated)
          fail(409, "ESTOQUE_INSUFICIENTE", `Estoque insuficiente para ${product.nome}.`);
        const amount = cents(product.preco) * BigInt(item.quantidade) - cents(item.desconto);
        if (amount < 0n) fail(422, "VALIDATION_ERROR", "Desconto maior que o valor da venda.");
        const sale = await one(
          tx,
          `INSERT INTO loja_venda(user_id,product_id,quantidade,preco_unitario,desconto,valor_total,metodo_pagamento,vendido_por)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            b.user_id,
            item.product_id,
            item.quantidade,
            product.preco,
            item.desconto,
            decimal(amount),
            b.metodo_pagamento,
            r.account.id,
          ],
        );
        vendas.push(sale);
        total += amount;
        // Free items are recorded as sales; no zero-value cash entry (DB forbids it).
        if (amount > 0n)
          lancamentos.push(
            await one(
              tx,
              `INSERT INTO cash_flow(tipo,valor,motivo,categoria,sale_id,registrado_por) VALUES('entrada',$1,$2,'loja',$3,$4) RETURNING *`,
              [decimal(amount), `Venda: ${product.nome}`, sale.sale_id, r.account.id],
            ),
          );
      }
      const result = { vendas, total: decimal(total), lancamentos };
      await tx.query(
        "UPDATE idempotency_keys SET response=$3::jsonb WHERE actor_id=$1 AND key=$2",
        [r.account.id, key, JSON.stringify(result)],
      );
      return result;
    });
    return reply.code(201).send(response);
  });
  route(
    app,
    ctx,
    "GET",
    "/vendas",
    {
      role: "admin",
      query: z.strictObject({
        ...page,
        ...range,
        user_id: uuid.optional(),
        product_id: uuid.optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT v.*,u.nome AS aluno_nome,p.nome AS produto_nome FROM loja_venda v JOIN users u ON u.id=v.user_id JOIN inventory_product p USING(product_id)
    WHERE ($1::uuid IS NULL OR v.user_id=$1) AND ($2::uuid IS NULL OR v.product_id=$2)
    AND ($3::date IS NULL OR v.data_venda>=($3::timestamp AT TIME ZONE 'America/Sao_Paulo')) AND ($4::date IS NULL OR v.data_venda<(($4::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')) ORDER BY v.data_venda DESC,v.sale_id`,
        [q.user_id ?? null, q.product_id ?? null, q.de ?? null, q.ate ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "GET",
    "/vendas/:sale_id",
    { role: "admin", params: z.strictObject({ sale_id: uuid }) },
    async (_r, _s, _b, _q, p) =>
      found(await one(db, "SELECT * FROM loja_venda WHERE sale_id=$1", [p.sale_id])),
  );
}
