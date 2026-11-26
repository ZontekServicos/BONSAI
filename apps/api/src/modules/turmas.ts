/**
 * Turmas (0010) e chamada por turma.
 *
 *   GET    /turmas                     lista (ativas; ?incluir_inativas=true)   admin, professor
 *   GET    /turmas/:id                 turma + alunos                            admin, professor
 *   POST   /turmas                     cria (com alunos opcionais)               admin
 *   PATCH  /turmas/:id                 nome, horário, modalidade, professor, ativa admin
 *   POST   /turmas/:id/alunos          vincula alunos (idempotente)              admin
 *   DELETE /turmas/:id/alunos/:user_id desvincula                                admin
 *   GET    /turmas/:id/chamada         alunos da turma + quem já está presente   admin, professor
 *   POST   /turmas/:id/chamada         registra as presenças marcadas (lote)     admin, professor
 *
 * A chamada grava em attendance (mesma tabela do check-in), com turma_id.
 * Regras, iguais às da recepção: aluno inadimplente/inativo é bloqueado; cada
 * aluno conta UMA presença por turma por dia (São Paulo); se ele já fez
 * check-in avulso hoje (QR/recepção, sem turma), esse registro é vinculado à
 * turma em vez de criar outro — total_presencas não é contado duas vezes.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one, type DB } from "../db.js";
import { route, uuid, text, modality, fail, found, STAFF, type Context } from "../http.js";
import { situation } from "./billing.js";

/** Início e fim do dia de hoje em São Paulo, para comparar com check_in (timestamptz). */
const HOJE_SP = `check_in >= (fn_hoje_sp()::timestamp AT TIME ZONE 'America/Sao_Paulo')
  AND check_in < ((fn_hoje_sp() + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;

const TURMA_SQL = `SELECT t.id, t.nome, t.horario, t.modalidade, t.professor_id, t.ativa,
       t.created_at, t.updated_at, pr.nome AS professor_nome,
       (SELECT count(*)::int FROM turma_alunos ta WHERE ta.turma_id = t.id) AS total_alunos
  FROM turmas t LEFT JOIN users pr ON pr.id = t.professor_id`;

const ids = z
  .array(uuid)
  .min(1)
  .max(200)
  .refine((v) => new Set(v).size === v.length, "Aluno repetido na lista.");

const campos = {
  nome: text(80).refine((v) => v.length >= 2, "Nome da turma muito curto."),
  horario: text(80).nullable().optional(),
  modalidade: modality.nullable().optional(),
  professor_id: uuid.nullable().optional(),
};

/** Professor da turma: professor ou gestor ativo (o trigger garante o papel no banco). */
async function validarProfessor(tx: DB, professor_id: string | null | undefined) {
  if (!professor_id) return;
  const p = await one(
    tx,
    "SELECT 1 FROM users WHERE id = $1 AND role IN ('professor', 'admin') AND status <> 'inativo'",
    [professor_id],
  );
  if (!p) fail(400, "PROFESSOR_INVALIDO", "Escolha um professor ativo da equipe.");
}

/** Vincula alunos; ignora quem já está na turma. O trigger recusa quem não é aluno. */
async function vincular(tx: DB, turma_id: string, user_ids: string[]) {
  const alunos = (
    await tx.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role = 'aluno'", [user_ids])
  ).rows.map((r) => r.id as string);
  const invalidos = user_ids.filter((id) => !alunos.includes(id));
  if (invalidos.length)
    fail(400, "ALUNO_INVALIDO", "Só alunos cadastrados podem entrar na turma.", { invalidos });
  const r = await tx.query(
    `INSERT INTO turma_alunos (turma_id, user_id)
     SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING RETURNING user_id`,
    [turma_id, user_ids],
  );
  return { adicionados: r.rowCount ?? 0, ja_na_turma: user_ids.length - (r.rowCount ?? 0) };
}

export function turmasRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const params = z.strictObject({ id: uuid });

  route(
    app,
    ctx,
    "GET",
    "/turmas",
    {
      role: STAFF,
      query: z.strictObject({
        incluir_inativas: z.enum(["true", "false"]).default("false"),
      }),
    },
    async (_r, _s, _b, q) =>
      (
        await db.query(
          `${TURMA_SQL} WHERE ($1 OR t.ativa) ORDER BY t.ativa DESC, lower(t.nome), t.id`,
          [q.incluir_inativas === "true"],
        )
      ).rows,
  );

  route(app, ctx, "GET", "/turmas/:id", { role: STAFF, params }, async (_r, _s, _b, _q, p) => {
    const turma = found(await one(db, `${TURMA_SQL} WHERE t.id = $1`, [p.id]));
    const alunos = (
      await db.query(
        `SELECT u.id AS user_id, u.nome, u.status, ap.modalidade, ap.faixa, ta.adicionado_em
           FROM turma_alunos ta
           JOIN users u ON u.id = ta.user_id
           JOIN aluno_profile ap ON ap.user_id = u.id
          WHERE ta.turma_id = $1
          ORDER BY u.nome, u.id`,
        [p.id],
      )
    ).rows;
    return { ...turma, alunos };
  });

  route(
    app,
    ctx,
    "POST",
    "/turmas",
    {
      role: "admin",
      body: z.strictObject({ ...campos, alunos: ids.optional() }),
    },
    async (_r, reply, b) => {
      const turma = await db.transaction(async (tx) => {
        await validarProfessor(tx, b.professor_id);
        const { id } = await one(
          tx,
          `INSERT INTO turmas (nome, horario, modalidade, professor_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [b.nome, b.horario ?? null, b.modalidade ?? null, b.professor_id ?? null],
        );
        if (b.alunos) await vincular(tx, id, b.alunos);
        return one(tx, `${TURMA_SQL} WHERE t.id = $1`, [id]);
      });
      return reply.code(201).send(turma);
    },
  );

  route(
    app,
    ctx,
    "PATCH",
    "/turmas/:id",
    {
      role: "admin",
      params,
      body: z
        .strictObject({ ...campos, nome: campos.nome.optional(), ativa: z.boolean().optional() })
        .refine((v) => Object.keys(v).length > 0, "Informe ao menos um campo."),
    },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        found(await one(tx, "SELECT 1 FROM turmas WHERE id = $1 FOR UPDATE", [p.id]));
        await validarProfessor(tx, b.professor_id);
        // undefined = não mexe; null = limpa (horário, modalidade, professor)
        const has = (k: keyof typeof b) => k in b;
        await tx.query(
          `UPDATE turmas SET
             nome         = CASE WHEN $2 THEN $3 ELSE nome END,
             horario      = CASE WHEN $4 THEN $5 ELSE horario END,
             modalidade   = CASE WHEN $6 THEN $7::modalidade ELSE modalidade END,
             professor_id = CASE WHEN $8 THEN $9::uuid ELSE professor_id END,
             ativa        = CASE WHEN $10 THEN $11 ELSE ativa END
           WHERE id = $1`,
          [
            p.id,
            has("nome"),
            b.nome ?? null,
            has("horario"),
            b.horario ?? null,
            has("modalidade"),
            b.modalidade ?? null,
            has("professor_id"),
            b.professor_id ?? null,
            has("ativa"),
            b.ativa ?? null,
          ],
        );
        return one(tx, `${TURMA_SQL} WHERE t.id = $1`, [p.id]);
      }),
  );

  route(
    app,
    ctx,
    "POST",
    "/turmas/:id/alunos",
    { role: "admin", params, body: z.strictObject({ user_ids: ids }) },
    async (_r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        found(await one(tx, "SELECT 1 FROM turmas WHERE id = $1 FOR UPDATE", [p.id]));
        return vincular(tx, p.id, b.user_ids);
      }),
  );

  route(
    app,
    ctx,
    "DELETE",
    "/turmas/:id/alunos/:user_id",
    { role: "admin", params: z.strictObject({ id: uuid, user_id: uuid }) },
    async (_r, reply, _b, _q, p) => {
      found(
        await one(
          db,
          "DELETE FROM turma_alunos WHERE turma_id = $1 AND user_id = $2 RETURNING user_id",
          [p.id, p.user_id],
        ),
      );
      return reply.code(204).send();
    },
  );

  route(
    app,
    ctx,
    "GET",
    "/turmas/:id/chamada",
    { role: STAFF, params },
    async (_r, _s, _b, _q, p) => {
      const turma = found(await one(db, `${TURMA_SQL} WHERE t.id = $1`, [p.id]));
      const alunos = (
        await db.query(
          // status = situação AGORA (mesma regra que bloqueia no envio):
          // users.status só é ressincronizado em check-in/pagamento.
          `SELECT u.id AS user_id, u.nome, ap.modalidade, ap.faixa,
                  CASE WHEN u.status = 'inativo' THEN 'inativo'
                       WHEN EXISTS (SELECT 1 FROM fn_pendencias_bloqueantes(u.id, $2)) THEN 'inadimplente'
                       ELSE 'ativo' END AS status,
                  EXISTS (SELECT 1 FROM attendance a
                           WHERE a.user_id = u.id AND a.turma_id = $1 AND ${HOJE_SP})
                    AS presente_hoje
             FROM turma_alunos ta
             JOIN users u ON u.id = ta.user_id
             JOIN aluno_profile ap ON ap.user_id = u.id
            WHERE ta.turma_id = $1
            ORDER BY u.nome, u.id`,
          [p.id, config.DIAS_CARENCIA],
        )
      ).rows;
      return {
        turma,
        data: (await one(db, "SELECT fn_hoje_sp()::text AS d")).d as string,
        alunos,
      };
    },
  );

  route(
    app,
    ctx,
    "POST",
    "/turmas/:id/chamada",
    { role: STAFF, params, body: z.strictObject({ presentes: ids }) },
    async (r, _s, b, _q, p) =>
      db.transaction(async (tx) => {
        const turma = found(
          await one(tx, "SELECT id, nome, ativa FROM turmas WHERE id = $1 FOR SHARE", [p.id]),
        );
        if (!turma.ativa) fail(409, "TURMA_INATIVA", "Esta turma está desativada.");
        const membros = (
          await tx.query(
            "SELECT user_id FROM turma_alunos WHERE turma_id = $1 AND user_id = ANY($2::uuid[])",
            [p.id, b.presentes],
          )
        ).rows.map((m) => m.user_id as string);
        const fora = b.presentes.filter((id) => !membros.includes(id));
        if (fora.length)
          fail(400, "ALUNO_FORA_DA_TURMA", "Há alunos marcados que não são desta turma.", {
            fora,
          });

        // Mesma ordem de lock do check-in/pagamento: users primeiro, por id.
        const ordenados = [...b.presentes].sort();
        await tx.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
          ordenados,
        ]);

        const resultado = {
          registrados: [] as string[],
          vinculados: [] as string[],
          ja_presentes: [] as string[],
          bloqueados: [] as { user_id: string; status: string }[],
          em_outra_turma: [] as string[],
        };
        for (const id of ordenados) {
          const s = await situation(tx, id, config);
          if (s.status !== "ativo") {
            resultado.bloqueados.push({ user_id: id, status: s.status });
            continue;
          }
          if (
            await one(
              tx,
              `SELECT 1 FROM attendance WHERE user_id = $1 AND turma_id = $2 AND ${HOJE_SP}`,
              [id, p.id],
            )
          ) {
            resultado.ja_presentes.push(id);
            continue;
          }
          // Check-in avulso de hoje (QR/recepção) vira a presença desta turma.
          const avulso = await one(
            tx,
            `UPDATE attendance SET turma_id = $2
              WHERE attendance_id = (
                SELECT attendance_id FROM attendance
                 WHERE user_id = $1 AND turma_id IS NULL AND ${HOJE_SP}
                 ORDER BY check_in DESC LIMIT 1)
              RETURNING attendance_id`,
            [id, p.id],
          );
          if (avulso) {
            resultado.vinculados.push(id);
            continue;
          }
          // Sessão ainda aberta de OUTRA turma: o índice de sessão aberta única
          // impediria a entrada; quem fecha é a recepção (check-out).
          if (
            await one(tx, "SELECT 1 FROM attendance WHERE user_id = $1 AND check_out IS NULL", [id])
          ) {
            resultado.em_outra_turma.push(id);
            continue;
          }
          await tx.query(
            "INSERT INTO attendance (user_id, registrado_por, turma_id) VALUES ($1, $2, $3)",
            [id, r.account.id, p.id],
          );
          resultado.registrados.push(id);
        }
        return { turma_id: p.id, ...resultado };
      }),
  );
}
