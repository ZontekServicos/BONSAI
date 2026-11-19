/**
 * Perfil do próprio aluno (0008): medidas e foto.
 *
 *   PATCH  /me/perfil   {altura?, peso?}   → aluno atualizado
 *   PUT    /me/foto     corpo = imagem (image/webp | image/jpeg, ≤ 512 KB)
 *   DELETE /me/foto
 *   GET    /fotos/:id   imagem (link imutável; um upload novo gera outro id)
 *
 * O aluno só altera o PRÓPRIO perfil e só estes campos; o professor vê o
 * resultado nas fichas (visão "macro") sem precisar digitar nada.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one } from "../db.js";
import { route, uuid, fail, found, type Context } from "../http.js";
import { aluno } from "./alunos.js";
import { perfilEditavelSchema } from "../../../../src/lib/perfil.js";
import { normalizarImagem } from "../image.js";

export function perfilRoutes(app: FastifyInstance, ctx: Context) {
  const { db } = ctx;

  // Mesmo handler em dois caminhos: /me/perfil (padrão do projeto, ao lado do
  // GET /me/perfil) e /profile (nome da especificação).
  for (const path of ["/me/perfil", "/profile"])
    route(
      app,
      ctx,
      "PATCH",
      path,
      { role: "aluno", body: perfilEditavelSchema },
      async (r, _s, b) =>
        db.transaction(async (tx) => {
          if (b.foto_url !== undefined) {
            const { foto_url: atual } = found(
              await one(tx, "SELECT foto_url FROM aluno_profile WHERE user_id=$1 FOR UPDATE", [
                r.account.id,
              ]),
            );
            if (b.foto_url === null) {
              await tx.query("DELETE FROM fotos WHERE user_id = $1", [r.account.id]);
              await tx.query("UPDATE aluno_profile SET foto_url = NULL WHERE user_id = $1", [
                r.account.id,
              ]);
            } else if (b.foto_url !== atual)
              fail(
                400,
                "VALIDATION_ERROR",
                "foto_url aceita só null (remover) ou a sua foto atual; para trocar, envie a imagem em PUT /me/foto.",
              );
          }
          const sets: string[] = [];
          const values: unknown[] = [r.account.id];
          for (const campo of ["altura", "peso"] as const)
            if (b[campo] !== undefined) {
              values.push(b[campo]);
              sets.push(`${campo} = $${values.length}`);
            }
          // Informou medida (mesmo igual à anterior) ⇒ "pesou hoje".
          if (sets.length)
            await tx.query(
              `UPDATE aluno_profile SET ${sets.join(", ")}, medidas_atualizadas_em = now()
                WHERE user_id = $1`,
              values,
            );
          return aluno(tx, r.account.id);
        }),
    );

  route(
    app,
    ctx,
    "PUT",
    "/me/foto",
    {
      role: "aluno",
      body: z.instanceof(Buffer, { error: "Envie a imagem como image/webp ou image/jpeg." }),
    },
    async (r, _s, dados) => {
      const imagem = await normalizarImagem(dados, r.headers["content-type"]);
      if (!imagem) fail(400, "VALIDATION_ERROR", "Arquivo não é uma imagem WebP ou JPEG válida.");
      return db.transaction(async (tx) => {
        // Troca atômica: apaga a anterior e grava a nova (1 foto por aluno).
        await tx.query("DELETE FROM fotos WHERE user_id = $1", [r.account.id]);
        const { id } = await one(
          tx,
          "INSERT INTO fotos(user_id, mime, dados) VALUES($1, $2, $3) RETURNING id",
          [r.account.id, imagem.mime, imagem.dados],
        );
        const foto_url = `/api/v1/fotos/${id}`;
        await tx.query("UPDATE aluno_profile SET foto_url = $2 WHERE user_id = $1", [
          r.account.id,
          foto_url,
        ]);
        return { foto_url };
      });
    },
  );

  route(app, ctx, "DELETE", "/me/foto", { role: "aluno" }, async (r, reply) => {
    await db.transaction(async (tx) => {
      await tx.query("DELETE FROM fotos WHERE user_id = $1", [r.account.id]);
      await tx.query("UPDATE aluno_profile SET foto_url = NULL WHERE user_id = $1", [r.account.id]);
    });
    return reply.code(204).send();
  });

  // Público por link: <img> não envia o token. O id é aleatório (122 bits) e
  // muda a cada upload; o link só aparece para o próprio aluno e para a equipe.
  route(
    app,
    ctx,
    "GET",
    "/fotos/:id",
    { role: "public", params: z.strictObject({ id: uuid }) },
    async (_r, reply, _b, _q, p) => {
      const foto = found(await one(db, "SELECT mime, dados FROM fotos WHERE id = $1", [p.id]));
      return reply
        .header("Content-Type", foto.mime)
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("Content-Security-Policy", "default-src 'none'")
        .header("Content-Disposition", "inline")
        .send(foto.dados);
    },
  );
}
