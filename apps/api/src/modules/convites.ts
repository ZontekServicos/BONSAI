/**
 * Convites de cadastro (0007).
 *
 *   Professor/gestor ── POST /convites {email} ──▶ link /cadastro?token=…
 *   Aluno (sem login) ── GET  /convites/validar/:token ──▶ libera o formulário
 *   Aluno (sem login) ── POST /convites/:token/cadastro ──▶ cria a conta + ficha
 *
 * O token tem 256 bits aleatórios e só o SHA-256 dele vai para o banco. O
 * e-mail da conta é sempre o do convite, e o convite é consumido na mesma
 * transação que cria o aluno (uso único, mesmo com cliques simultâneos).
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one, type DB } from "../db.js";
import { route, uuid, page, paginate, fail, found, STAFF, type Context } from "../http.js";
import { hashPassword, limit } from "../auth.js";
import { inserirAluno } from "./cadastro.js";
import { cadastroConviteSchema, novoConviteSchema } from "../../../../src/lib/cadastro.js";
import type { ConviteStatus } from "../../../../src/types/contract.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** 32 bytes em base64url = 43 caracteres. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

const STATUS_SQL = `CASE WHEN c.utilizado THEN 'utilizado'
  WHEN c.revogado_em IS NOT NULL THEN 'revogado'
  WHEN c.data_expiracao <= now() THEN 'expirado'
  ELSE 'pendente' END`;
const CONVITE_COLUMNS = `c.id, c.email_destinatario, c.whatsapp_destinatario, c.data_expiracao,
  ${STATUS_SQL} AS status, c.utilizado_em, c.aluno_id, c.criado_por, u.nome AS criado_por_nome,
  c.created_at`;

const RECUSA: Record<Exclude<ConviteStatus, "pendente">, [number, string, string]> = {
  utilizado: [
    410,
    "CONVITE_UTILIZADO",
    "Este convite já foi usado. Entre com o e-mail e a senha cadastrados.",
  ],
  revogado: [
    410,
    "CONVITE_REVOGADO",
    "Este convite foi cancelado ou substituído. Peça um novo link à academia.",
  ],
  expirado: [410, "CONVITE_EXPIRADO", "Este convite expirou. Peça um novo link à academia."],
};

/** Busca o convite pelo token e recusa se não puder mais ser usado. */
async function conviteUtilizavel(db: DB, token: string, lock = false) {
  const row = TOKEN_FORMAT.test(token)
    ? await one(
        db,
        `SELECT c.id, c.email_destinatario, c.data_expiracao, ${STATUS_SQL} AS status,
                u.nome AS convidado_por
           FROM convites c JOIN users u ON u.id = c.criado_por
          WHERE c.token_hash = $1 ${lock ? "FOR UPDATE OF c" : ""}`,
        [sha256(token)],
      )
    : undefined;
  if (!row) fail(404, "CONVITE_INVALIDO", "Convite inválido. Confira o link recebido.");
  if (row.status !== "pendente") fail(...RECUSA[row.status as keyof typeof RECUSA]);
  return row as { id: string; email_destinatario: string; data_expiracao: Date; convidado_por: string };
}

export function convitesRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const origin = config.CORS_ORIGIN.replace(/\/$/, "");
  const dataBR = (d: Date) =>
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(d);

  // -------------------------------------------------------------------------
  // Equipe (professor ou gestor)
  // -------------------------------------------------------------------------
  route(
    app,
    ctx,
    "POST",
    "/convites",
    { role: STAFF, body: novoConviteSchema },
    async (r, reply, b) => {
      if (await one(db, "SELECT 1 FROM users WHERE email=$1", [b.email]))
        fail(409, "EMAIL_JA_CADASTRADO", "Já existe uma conta com este e-mail.");
      const token = randomBytes(32).toString("base64url");
      const row = await db.transaction(async (tx) => {
        // Um convite em aberto por e-mail: o link novo invalida o anterior.
        await tx.query(
          `UPDATE convites SET revogado_em = now()
            WHERE email_destinatario = $1 AND NOT utilizado AND revogado_em IS NULL`,
          [b.email],
        );
        const { id } = await one(
          tx,
          `INSERT INTO convites(token_hash, email_destinatario, whatsapp_destinatario,
             data_expiracao, criado_por)
           VALUES($1, $2, $3, now() + make_interval(days => $4), $5) RETURNING id`,
          [sha256(token), b.email, b.whatsapp, b.validade_dias, r.account.id],
        );
        return one(
          tx,
          `SELECT ${CONVITE_COLUMNS} FROM convites c JOIN users u ON u.id=c.criado_por WHERE c.id=$1`,
          [id],
        );
      });
      const url = `${origin}/cadastro?token=${token}`;
      const mensagem =
        `Olá! Você foi convidado(a) para se cadastrar na BONSAI Jiu-Jitsu Fight. ` +
        `Preencha sua ficha por este link (válido até ${dataBR(row.data_expiracao)}): ${url}`;
      return reply.code(201).send({
        ...row,
        url,
        whatsapp_url: b.whatsapp
          ? `https://wa.me/${b.whatsapp}?text=${encodeURIComponent(mensagem)}`
          : null,
      });
    },
  );

  route(
    app,
    ctx,
    "GET",
    "/convites",
    {
      role: STAFF,
      query: z.strictObject({
        ...page,
        status: z.enum(["pendente", "expirado", "utilizado", "revogado"]).optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT * FROM (
           SELECT ${CONVITE_COLUMNS} FROM convites c JOIN users u ON u.id = c.criado_por
         ) convites
         WHERE ($1::text IS NULL OR status = $1)
         ORDER BY created_at DESC, id`,
        [q.status ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );

  route(
    app,
    ctx,
    "DELETE",
    "/convites/:id",
    { role: STAFF, params: z.strictObject({ id: uuid }) },
    async (_r, _s, _b, _q, p) =>
      db.transaction(async (tx) => {
        const c = found(
          await one(tx, "SELECT utilizado, revogado_em FROM convites WHERE id=$1 FOR UPDATE", [
            p.id,
          ]),
        );
        if (c.utilizado) fail(409, "CONVITE_UTILIZADO", "Convite já utilizado: não há o que revogar.");
        if (!c.revogado_em)
          await tx.query("UPDATE convites SET revogado_em = now() WHERE id=$1", [p.id]);
        return one(
          tx,
          `SELECT ${CONVITE_COLUMNS} FROM convites c JOIN users u ON u.id=c.criado_por WHERE c.id=$1`,
          [p.id],
        );
      }),
  );

  // -------------------------------------------------------------------------
  // Público (quem tem o link)
  // -------------------------------------------------------------------------
  const tokenParams = z.strictObject({ token: z.string().max(100) });

  route(
    app,
    ctx,
    "GET",
    "/convites/validar/:token",
    { role: "public", params: tokenParams },
    async (r, _s, _b, _q, p) => {
      await limit(db, `convite-validar:${r.ip}`, 30);
      const c = await conviteUtilizavel(db, p.token);
      return {
        email: c.email_destinatario,
        data_expiracao: c.data_expiracao,
        convidado_por: c.convidado_por,
      };
    },
  );

  route(
    app,
    ctx,
    "POST",
    "/convites/:token/cadastro",
    { role: "public", params: tokenParams, body: cadastroConviteSchema },
    async (r, reply, b, _q, p) => {
      await limit(db, `convite-cadastro:${r.ip}`, 10);
      // Checagem barata antes do Argon2 (não gasta CPU com link inválido).
      await conviteUtilizavel(db, p.token);
      const password = await hashPassword(b.acesso.senha_inicial);
      const aluno = await db.transaction(async (tx) => {
        // Revalida com lock: dois envios simultâneos não criam duas contas.
        const c = await conviteUtilizavel(tx, p.token, true);
        const id = await inserirAluno(
          tx,
          { ...b, acesso: { nome: b.acesso.nome, email: c.email_destinatario } },
          password,
          null, // anamnese declarada pelo próprio aluno (ou responsável)
        );
        await tx.query(
          `UPDATE convites SET utilizado = true, utilizado_em = now(), aluno_id = $2 WHERE id = $1`,
          [c.id, id],
        );
        return { id, nome: b.acesso.nome, email: c.email_destinatario };
      });
      return reply.code(201).send(aluno);
    },
  );
}
