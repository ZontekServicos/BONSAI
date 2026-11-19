import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { one, type DB } from "../db.js";
import {
  route,
  uuid,
  modality,
  page,
  range,
  paginate,
  fail,
  found,
  STAFF,
  type Context,
} from "../http.js";
import { situation } from "./billing.js";
import { aluno } from "./alunos.js";

export function attendanceRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const key = new TextEncoder().encode(config.JWT_QR_SECRET);
  async function decode(token: string) {
    try {
      const { payload } = await jwtVerify(token, key, {
        algorithms: ["HS256"],
        issuer: "bonsai",
        audience: "bonsai-reception",
      });
      if (payload.typ !== "carteirinha" || !payload.sub || !uuid.safeParse(payload.sub).success)
        throw new Error();
      return payload.sub;
    } catch {
      fail(400, "QR_INVALIDO", "QR inválido ou expirado.");
    }
  }
  async function enter(tx: DB, id: string, actor: string) {
    return one(tx, "INSERT INTO attendance(user_id,registrado_por) VALUES($1,$2) RETURNING *", [
      id,
      actor,
    ]);
  }
  route(app, ctx, "GET", "/me/carteirinha", { role: "aluno" }, async (r) => {
    const result = await db.transaction(async (tx) => ({
      s: await situation(tx, r.account.id, config),
      a: await aluno(tx, r.account.id),
    }));
    if (result.s.status !== "ativo")
      fail(
        403,
        result.s.status === "inativo" ? "ALUNO_INATIVO" : "CARTEIRINHA_BLOQUEADA",
        "Carteirinha bloqueada.",
        result.s,
      );
    const exp = Math.floor(Date.now() / 1000) + 90;
    const qr_token = await new SignJWT({ typ: "carteirinha" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(r.account.id)
      .setIssuer("bonsai")
      .setAudience("bonsai-reception")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(key);
    return {
      ...result.a.perfil,
      nome: result.a.nome,
      qr_token,
      qr_expires_at: new Date(exp * 1000).toISOString(),
    };
  });
  route(
    app,
    ctx,
    "POST",
    "/carteirinha/validar",
    {
      role: STAFF,
      body: z.strictObject({
        qr_token: z.string().min(1).max(2048),
        registrar_checkin: z.boolean().default(false),
      }),
    },
    async (r, _s, b) => {
      const id = await decode(b.qr_token);
      return db.transaction(async (tx) => {
        const s = await situation(tx, id, config);
        if (s.status !== "ativo")
          return {
            liberado: false,
            motivo: s.status === "inativo" ? "ALUNO_INATIVO" : "CARTEIRINHA_BLOQUEADA",
            pendencias: s.pendencias,
          };
        const attendance = b.registrar_checkin ? await enter(tx, id, r.account.id) : undefined;
        return {
          liberado: true,
          aluno: await aluno(tx, id),
          ...(attendance ? { attendance } : {}),
        };
      });
    },
  );
  route(
    app,
    ctx,
    "POST",
    "/presencas/check-in",
    {
      role: STAFF,
      body: z.union([
        z.strictObject({ user_id: uuid }),
        z.strictObject({ qr_token: z.string().min(1).max(2048) }),
      ]),
    },
    async (r, reply, b) => {
      const id = "user_id" in b ? b.user_id : await decode(b.qr_token);
      const result = await db.transaction(async (tx) => {
        const s = await situation(tx, id, config);
        if (s.status !== "ativo") return { s };
        return { attendance: await enter(tx, id, r.account.id) };
      });
      if (result.s)
        fail(
          403,
          result.s.status === "inativo" ? "ALUNO_INATIVO" : "CARTEIRINHA_BLOQUEADA",
          "Entrada bloqueada.",
          result.s,
        );
      return reply.code(201).send(result.attendance);
    },
  );
  for (const byUser of [false, true])
    route(
      app,
      ctx,
      "PATCH",
      byUser ? "/presencas/check-out" : "/presencas/:attendance_id/check-out",
      {
        role: STAFF,
        params: byUser
          ? z.strictObject({ attendance_id: uuid.optional() })
          : z.strictObject({ attendance_id: uuid }),
        body: byUser
          ? z.strictObject({ user_id: uuid })
          : z.strictObject({ user_id: uuid.optional() }),
      },
      async (_r, _s, b, _q, p) => {
        const row = await one(
          db,
          `UPDATE attendance SET check_out=greatest(clock_timestamp(),check_in+interval '1 microsecond') WHERE ${byUser ? "user_id" : "attendance_id"}=$1 AND check_out IS NULL RETURNING *`,
          [byUser ? b.user_id : p.attendance_id],
        );
        if (!row) fail(409, "SEM_CHECKIN_ABERTO", "Não existe presença aberta.");
        return row;
      },
    );
  route(
    app,
    ctx,
    "GET",
    "/presencas/ativas",
    { role: STAFF, query: z.strictObject({ modalidade: modality.optional() }) },
    async (_r, _s, _b, q) =>
      (
        await db.query(
          "SELECT * FROM vw_presentes_agora WHERE ($1::modalidade IS NULL OR modalidade=$1) ORDER BY check_in",
          [q.modalidade ?? null],
        )
      ).rows,
  );
  route(
    app,
    ctx,
    "GET",
    "/presencas",
    {
      role: STAFF,
      query: z.strictObject({
        ...page,
        ...range,
        user_id: uuid.optional(),
        modalidade: modality.optional(),
      }),
    },
    (_r, _s, _b, q) =>
      paginate(
        db,
        `SELECT a.*,u.nome FROM attendance a JOIN users u ON u.id=a.user_id JOIN aluno_profile p ON p.user_id=u.id
    WHERE ($1::uuid IS NULL OR a.user_id=$1) AND ($2::date IS NULL OR a.check_in>=($2::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($3::date IS NULL OR a.check_in<(($3::date+1)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
    AND ($4::modalidade IS NULL OR p.modalidade=$4) ORDER BY a.check_in DESC,a.attendance_id`,
        [q.user_id ?? null, q.de ?? null, q.ate ?? null, q.modalidade ?? null],
        { page: q.page, page_size: q.page_size },
      ),
  );
  route(
    app,
    ctx,
    "GET",
    "/presencas/estatisticas",
    { role: STAFF, query: z.strictObject(range) },
    async (_r, _s, _b, q) => {
      const base = `FROM attendance a JOIN aluno_profile p ON p.user_id=a.user_id
      WHERE a.check_in >= (coalesce($1::date,fn_hoje_sp()-30)::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND a.check_in < ((coalesce($2::date,fn_hoje_sp())+1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;
      const values = [q.de ?? null, q.ate ?? null];
      const [days, mods, hours] = await Promise.all([
        db.query(
          `SELECT (a.check_in AT TIME ZONE 'America/Sao_Paulo')::date AS dia,count(*)::int AS total ${base} GROUP BY 1 ORDER BY 1`,
          values,
        ),
        db.query(
          `SELECT p.modalidade,count(*)::int AS total ${base} GROUP BY 1 ORDER BY 1`,
          values,
        ),
        db.query(
          `SELECT extract(hour FROM a.check_in AT TIME ZONE 'America/Sao_Paulo')::int AS hora,count(*)::int AS total ${base} GROUP BY 1 ORDER BY total DESC,hora LIMIT 1`,
          values,
        ),
      ]);
      return { por_dia: days.rows, por_modalidade: mods.rows, pico_horario: hours.rows[0] ?? null };
    },
  );
}
