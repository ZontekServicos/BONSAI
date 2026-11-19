import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one, userColumns, type DB } from "../db.js";
import {
  route,
  text,
  uuid,
  page,
  paginate,
  fail,
  found,
  staffOrSelf,
  STAFF,
  type Context,
} from "../http.js";
import { hashPassword } from "../auth.js";
import { aluno } from "./alunos.js";
import { cadastroAlunoSchema } from "../../../../src/lib/cadastro.js";

/** Ficha completa do aluno. Inclui dados sensíveis: só staff ou o próprio aluno. */
export async function ficha(db: DB, id: string) {
  const base = await aluno(db, id);
  const row = await one(
    db,
    `SELECT p.genero, p.rg, p.cpf, p.data_nascimento, p.endereco, p.bairro, p.cidade, p.cep,
            p.whatsapp, p.professor_responsavel,
            (p.data_nascimento > (fn_hoje_sp() - interval '18 years')::date) AS menor_de_idade,
            p.termos_aceitos, p.termos_aceitos_em, p.termos_versao,
            CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
              'id', r.id, 'nome', r.nome, 'parentesco', r.parentesco, 'whatsapp', r.whatsapp,
              'telefone_emergencia', r.telefone_emergencia, 'email', r.email) END AS responsavel,
            CASE WHEN s.user_id IS NULL THEN NULL ELSE json_build_object(
              'tipo_sanguineo', s.tipo_sanguineo, 'condicoes_medicas', s.condicoes_medicas,
              'lesoes_cronicas', s.lesoes_cronicas, 'medicacao_continua', s.medicacao_continua,
              'artes_marciais_anteriores', s.artes_marciais_anteriores,
              'atualizado_por', s.atualizado_por, 'created_at', s.created_at,
              'updated_at', s.updated_at) END AS saude,
            json_build_object('whatsapp', c.whatsapp, 'origem', c.origem) AS contato_principal
       FROM aluno_profile p
       LEFT JOIN responsaveis r ON r.id = p.responsavel_id
       LEFT JOIN historico_saude s ON s.user_id = p.user_id
       JOIN vw_contato_aluno c ON c.user_id = p.user_id
      WHERE p.user_id = $1`,
    [id],
  );
  return { ...base, ficha: row };
}

export function cadastroRoutes(app: FastifyInstance, ctx: Context) {
  const { db } = ctx;
  const params = z.strictObject({ id: uuid });

  // -------------------------------------------------------------------------
  // POST /alunos/cadastro — responsável → aluno → saúde, tudo ou nada.
  // -------------------------------------------------------------------------
  route(
    app,
    ctx,
    "POST",
    "/alunos/cadastro",
    { role: STAFF, body: cadastroAlunoSchema },
    async (r, reply, b) => {
      const { aluno: a, saude: s, responsavel, termos } = b;
      // Argon2 fora da transação: não segura conexão/locks durante o hash.
      const password = await hashPassword(a.senha_inicial);
      const result = await db.transaction(async (tx) => {
        // 1. Responsável (novo ou existente). Se qualquer passo seguinte falhar,
        //    o ROLLBACK desfaz também o responsável recém-criado.
        let responsavelId: string | null = null;
        if (responsavel && "id" in responsavel) {
          const existing = await one(tx, "SELECT id FROM responsaveis WHERE id=$1 FOR SHARE", [
            responsavel.id,
          ]);
          if (!existing)
            fail(422, "RESPONSAVEL_NAO_ENCONTRADO", "Responsável informado não existe.");
          responsavelId = existing.id;
        } else if (responsavel) {
          responsavelId = (
            await one(
              tx,
              `INSERT INTO responsaveis(nome,parentesco,whatsapp,telefone_emergencia,email)
               VALUES($1,$2,$3,$4,$5) RETURNING id`,
              [
                responsavel.nome,
                responsavel.parentesco,
                responsavel.whatsapp,
                responsavel.telefone_emergencia,
                responsavel.email,
              ],
            )
          ).id;
        }
        // 2. Conta + perfil do aluno vinculado ao responsável.
        const user = await one(
          tx,
          `INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,'aluno') RETURNING id`,
          [a.nome, a.email, password],
        );
        await tx.query(
          `INSERT INTO aluno_profile(
             user_id, modalidade, faixa, graduacao_nivel, data_matricula,
             genero, rg, cpf, data_nascimento, endereco, bairro, cidade, cep, whatsapp,
             professor_responsavel, responsavel_id, termos_aceitos, termos_aceitos_em, termos_versao)
           VALUES($1,$2,$3,$4,coalesce($5::date,fn_hoje_sp()),
             $6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true,now(),$17)`,
          [
            user.id,
            a.modalidade,
            a.faixa,
            a.graduacao_nivel,
            a.data_matricula ?? null,
            a.genero,
            a.rg,
            a.cpf,
            a.data_nascimento,
            a.endereco,
            a.bairro,
            a.cidade,
            a.cep,
            a.whatsapp,
            a.professor_responsavel,
            responsavelId,
            termos.versao,
          ],
        );
        // 3. Histórico de saúde (1:1).
        await tx.query(
          `INSERT INTO historico_saude(user_id,tipo_sanguineo,condicoes_medicas,lesoes_cronicas,
             medicacao_continua,artes_marciais_anteriores,atualizado_por)
           VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            user.id,
            s.tipo_sanguineo,
            s.condicoes_medicas,
            s.lesoes_cronicas,
            s.medicacao_continua,
            s.artes_marciais_anteriores,
            r.account.id,
          ],
        );
        return ficha(tx, user.id);
      });
      return reply.code(201).send(result);
    },
  );

  route(app, ctx, "GET", "/alunos/:id/ficha", { params }, async (r, _s, _b, _q, p) => {
    staffOrSelf(r, p.id);
    return ficha(db, p.id);
  });

  // Busca de responsáveis para vincular irmãos ao mesmo responsável.
  route(
    app,
    ctx,
    "GET",
    "/responsaveis",
    { role: STAFF, query: z.strictObject({ ...page, q: text().optional() }) },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT r.id, r.nome, r.parentesco, r.whatsapp, r.telefone_emergencia, r.email,
                (SELECT count(*)::int FROM aluno_profile p WHERE p.responsavel_id = r.id) AS alunos
           FROM responsaveis r
          WHERE ($1::text IS NULL OR r.nome ILIKE '%'||$1||'%'
                 OR (regexp_replace($1,'\\D','','g') <> ''
                     AND r.whatsapp LIKE '%'||regexp_replace($1,'\\D','','g')||'%'))
          ORDER BY r.nome, r.id`,
        [q.q ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );

  // -------------------------------------------------------------------------
  // Equipe: contas de professor (somente admin).
  // -------------------------------------------------------------------------
  route(
    app,
    ctx,
    "GET",
    "/professores",
    { role: "admin" },
    async () =>
      (
        await db.query(
          `SELECT ${userColumns} FROM users WHERE role='professor' ORDER BY status, nome, id`,
        )
      ).rows,
  );
  route(
    app,
    ctx,
    "POST",
    "/professores",
    {
      role: "admin",
      body: z.strictObject({
        nome: text().min(2),
        email: z.email().max(254),
        senha_inicial: z.string().min(12).max(128),
      }),
    },
    async (_r, reply, b) => {
      const password = await hashPassword(b.senha_inicial);
      const row = await one(
        db,
        `INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,'professor')
         RETURNING ${userColumns}`,
        [b.nome, b.email, password],
      );
      return reply.code(201).send(row);
    },
  );
  route(
    app,
    ctx,
    "PATCH",
    "/professores/:id/status",
    { role: "admin", params, body: z.strictObject({ status: z.enum(["ativo", "inativo"]) }) },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        const row = found(
          await one(
            tx,
            `UPDATE users SET status=$2 WHERE id=$1 AND role='professor' RETURNING ${userColumns}`,
            [p.id, b.status],
          ),
        );
        if (b.status === "inativo")
          await tx.query(
            "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
            [p.id],
          );
        return row;
      }),
  );
}
