/**
 * Loja (0009): catálogo para o aluno + pedido de intenção via WhatsApp.
 *
 *   GET   /loja/produtos            catálogo (ativo = true)          qualquer usuário logado
 *   POST  /loja/pedido              registra a intenção → link wa.me aluno
 *   GET   /loja/pedidos             pedidos dos alunos               admin
 *   PATCH /loja/pedidos/:id         atendido | cancelado             admin
 *   PUT   /produtos/:id/imagem      foto do produto (binário)        admin
 *   DELETE /produtos/:id/imagem                                      admin
 *   GET   /loja/imagens/:id         imagem (link imutável)           público
 *
 * O pedido NÃO baixa estoque nem lança no caixa: é só a intenção. A venda de
 * fato continua no balcão (POST /vendas), que já cuida de estoque e caixa.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import { route, uuid, text, page, paginate, fail, found, type Context } from "../http.js";
import { limit } from "../auth.js";
import { normalizarImagem } from "../image.js";

/** Campos no formato da especificação (id, estoque) a partir de inventory_product. */
const PRODUTO_LOJA = `p.product_id AS id, p.nome, p.descricao, p.preco, p.imagem_url,
  p.estoque_atual AS estoque, p.categoria`;

/** Mensagem pedida na especificação (quantidade só aparece quando > 1). */
export const mensagemPedido = (nome: string, quantidade = 1) =>
  `Olá, gostaria de adquirir o item ${nome}` + (quantidade > 1 ? ` (${quantidade} unidades)` : "");

export function lojaRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const params = z.strictObject({ id: uuid });

  // -------------------------------------------------------------------------
  // Aluno
  // -------------------------------------------------------------------------
  route(
    app,
    ctx,
    "GET",
    "/loja/produtos",
    { query: z.strictObject({ categoria: text(60).optional(), q: text().optional() }) },
    async (_r, _s, _b, q) =>
      (
        await db.query(
          `SELECT ${PRODUTO_LOJA} FROM inventory_product p
            WHERE p.ativo
              AND ($1::text IS NULL OR p.categoria = $1)
              AND ($2::text IS NULL OR p.nome ILIKE '%'||$2||'%')
            ORDER BY (p.estoque_atual > 0) DESC, p.nome, p.product_id`,
          [q.categoria ?? null, q.q ?? null],
        )
      ).rows,
  );

  route(
    app,
    ctx,
    "POST",
    "/loja/pedido",
    {
      role: "aluno",
      body: z.strictObject({
        produto_id: uuid,
        quantidade: z.number().int().min(1).max(10).default(1),
      }),
    },
    async (r, reply, b) => {
      const whatsapp = config.WHATSAPP_LOJA;
      if (!whatsapp)
        fail(
          503,
          "LOJA_SEM_WHATSAPP",
          "A academia ainda não configurou o WhatsApp da loja. Fale com a recepção.",
        );
      await limit(db, `pedido-loja:${r.account.id}`, 10);
      const { pedido, nome } = await db.transaction(async (tx) => {
        const produto = await one(
          tx,
          `SELECT product_id, nome, preco, estoque_atual FROM inventory_product
            WHERE product_id = $1 AND ativo FOR SHARE`,
          [b.produto_id],
        );
        if (!produto) fail(404, "NAO_ENCONTRADO", "Produto não encontrado.");
        if (produto.estoque_atual < b.quantidade)
          fail(409, "PRODUTO_ESGOTADO", "Produto sem estoque no momento.");
        // Clicar de novo no mesmo produto reaproveita o pedido em aberto.
        const pedido = await one(
          tx,
          `INSERT INTO pedidos_loja(user_id, product_id, quantidade, preco_unitario)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, product_id) WHERE status = 'solicitado'
           DO UPDATE SET quantidade = EXCLUDED.quantidade, preco_unitario = EXCLUDED.preco_unitario
           RETURNING *, (xmax = 0) AS novo`,
          [r.account.id, produto.product_id, b.quantidade, produto.preco],
        );
        return { pedido, nome: produto.nome as string };
      });
      const { novo, ...dados } = pedido;
      return reply.code(novo ? 201 : 200).send({
        pedido: dados,
        whatsapp_url: `https://wa.me/${whatsapp}?text=${encodeURIComponent(
          mensagemPedido(nome, b.quantidade),
        )}`,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Gestor
  // -------------------------------------------------------------------------
  route(
    app,
    ctx,
    "GET",
    "/loja/pedidos",
    {
      role: "admin",
      query: z.strictObject({
        ...page,
        status: z.enum(["solicitado", "atendido", "cancelado"]).optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT o.*, u.nome AS aluno_nome, u.email AS aluno_email, p.nome AS produto_nome,
                p.estoque_atual AS produto_estoque
           FROM pedidos_loja o
           JOIN users u ON u.id = o.user_id
           JOIN inventory_product p ON p.product_id = o.product_id
          WHERE ($1::pedido_loja_status IS NULL OR o.status = $1)
          ORDER BY (o.status = 'solicitado') DESC, o.created_at DESC, o.id`,
        [q.status ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );

  route(
    app,
    ctx,
    "PATCH",
    "/loja/pedidos/:id",
    {
      role: "admin",
      params,
      body: z.strictObject({ status: z.enum(["atendido", "cancelado"]) }),
    },
    async (r, _s, b, _q, p) => {
      const row = await one(
        db,
        `UPDATE pedidos_loja SET status = $2, atendido_por = $3, atendido_em = now()
          WHERE id = $1 AND status = 'solicitado' RETURNING *`,
        [p.id, b.status, r.account.id],
      );
      if (row) return row;
      found(await one(db, "SELECT 1 FROM pedidos_loja WHERE id = $1", [p.id]));
      fail(409, "PEDIDO_FINALIZADO", "Este pedido já foi atendido ou cancelado.");
    },
  );

  route(
    app,
    ctx,
    "PUT",
    "/produtos/:id/imagem",
    {
      role: "admin",
      params,
      body: z.instanceof(Buffer, { error: "Envie a imagem como image/webp ou image/jpeg." }),
    },
    async (r, _s, dados, _q, p) => {
      const imagem = await normalizarImagem(dados, r.headers["content-type"]);
      if (!imagem) fail(400, "VALIDATION_ERROR", "Arquivo não é uma imagem WebP ou JPEG válida.");
      return db.transaction(async (tx) => {
        found(
          await one(tx, "SELECT 1 FROM inventory_product WHERE product_id = $1 FOR UPDATE", [p.id]),
        );
        await tx.query("DELETE FROM produto_imagens WHERE product_id = $1", [p.id]);
        const { id } = await one(
          tx,
          "INSERT INTO produto_imagens(product_id, mime, dados) VALUES ($1, $2, $3) RETURNING id",
          [p.id, imagem.mime, imagem.dados],
        );
        return one(
          tx,
          "UPDATE inventory_product SET imagem_url = $2 WHERE product_id = $1 RETURNING *",
          [p.id, `/api/v1/loja/imagens/${id}`],
        );
      });
    },
  );

  route(
    app,
    ctx,
    "DELETE",
    "/produtos/:id/imagem",
    { role: "admin", params },
    async (_r, _s, _b, _q, p) =>
      db.transaction(async (tx) => {
        const row = found(
          await one(
            tx,
            "UPDATE inventory_product SET imagem_url = NULL WHERE product_id = $1 RETURNING *",
            [p.id],
          ),
        );
        await tx.query("DELETE FROM produto_imagens WHERE product_id = $1", [p.id]);
        return row;
      }),
  );

  route(
    app,
    ctx,
    "GET",
    "/loja/imagens/:id",
    { role: "public", params },
    async (_r, reply, _b, _q, p) => {
      const img = found(
        await one(db, "SELECT mime, dados FROM produto_imagens WHERE id = $1", [p.id]),
      );
      return reply
        .header("Content-Type", img.mime)
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Content-Security-Policy", "default-src 'none'")
        .header("Content-Disposition", "inline")
        .send(img.dados);
    },
  );
}
