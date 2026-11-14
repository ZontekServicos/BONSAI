import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "../../../src/types/contract.js";
import { one, userColumns, type DB, type Database } from "./db.js";
import type { Config } from "./config.js";
import { fail, route, type Context } from "./http.js";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashPassword = (s: string) =>
  hash(s, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export async function limit(db: DB, key: string, max: number) {
  const row = await one(
    db,
    `INSERT INTO api_rate_limits(key,window_start,hits) VALUES($1,date_trunc('minute',now()),1)
    ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN api_rate_limits.window_start=EXCLUDED.window_start THEN api_rate_limits.hits+1 ELSE 1 END,
    window_start=EXCLUDED.window_start RETURNING hits`,
    [digest(key)],
  );
  if (row.hits > max) fail(429, "RATE_LIMITED", "Muitas tentativas. Aguarde um minuto.");
}
export function makeAuth(db: Database, config: Config) {
  const accessKey = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
  return async (r: FastifyRequest) => {
    const token = r.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) fail(401, "NAO_AUTENTICADO", "Entre na sua conta.");
    let claims;
    try {
      claims = (
        await jwtVerify(token, accessKey, {
          algorithms: ["HS256"],
          issuer: "bonsai",
          audience: "bonsai-api",
        })
      ).payload;
    } catch {
      fail(401, "TOKEN_EXPIRADO", "Sessão expirada.");
    }
    if (typeof claims.sub !== "string" || typeof claims.sid !== "string" || claims.typ !== "access")
      fail(401, "NAO_AUTENTICADO", "Sessão inválida.");
    const user = await one<User>(
      db,
      `SELECT ${userColumns} FROM users WHERE id=$1 AND EXISTS
      (SELECT 1 FROM refresh_tokens WHERE user_id=users.id AND family_id=$2 AND revoked_at IS NULL AND expires_at>now())`,
      [claims.sub, claims.sid],
    );
    if (!user) fail(401, "NAO_AUTENTICADO", "Sessão encerrada.");
    if (user.status === "inativo") fail(403, "ALUNO_INATIVO", "Cadastro inativo.");
    r.account = user;
    r.tokenExp = Number(claims.exp);
    await limit(db, `user:${user.id}`, 300);
  };
}
const cookieName = "bonsai_refresh";
function cookieOptions(c: Config) {
  return {
    httpOnly: true,
    secure: c.NODE_ENV === "production",
    sameSite: c.COOKIE_SAME_SITE,
    path: "/api/v1/auth",
    maxAge: 30 * 86400,
  };
}
async function session(
  db: DB,
  config: Config,
  user: User,
  r: FastifyRequest,
  family = randomUUID(),
) {
  const token = randomBytes(32).toString("base64url");
  const row = await one(
    db,
    `INSERT INTO refresh_tokens(user_id,token_hash,expires_at,user_agent,ip,family_id)
    VALUES($1,$2,now()+interval '30 days',$3,$4,$5) RETURNING token_id`,
    [user.id, digest(token), r.headers["user-agent"]?.slice(0, 500) ?? null, r.ip, family],
  );
  const access_token = await new SignJWT({
    role: user.role,
    status: user.status,
    typ: "access",
    sid: family,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(user.id)
    .setIssuer("bonsai")
    .setAudience("bonsai-api")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(config.JWT_ACCESS_SECRET));
  return { token, tokenId: row.token_id, response: { access_token, expires_in: 900, user } };
}
function origin(r: FastifyRequest, c: Config) {
  if (r.headers.origin !== c.CORS_ORIGIN) fail(403, "SEM_PERMISSAO", "Origem não autorizada.");
}
export async function authRoutes(app: FastifyInstance, ctx: Context) {
  const { db, config } = ctx;
  const dummy = await hashPassword(randomBytes(24).toString("hex"));
  const password = z.string().min(8).max(128);
  route(
    app,
    ctx,
    "POST",
    "/auth/login",
    {
      role: "public",
      body: z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(128) }),
    },
    async (r, reply, b) => {
      origin(r, config);
      await limit(db, `login-ip:${r.ip}`, 20);
      await limit(db, `login:${r.ip}:${b.email.toLowerCase()}`, 5);
      const row = await one(db, `SELECT ${userColumns},password_hash FROM users WHERE email=$1`, [
        b.email,
      ]);
      const ok = await verify(row?.password_hash ?? dummy, b.password);
      if (!row || !ok) fail(401, "CREDENCIAIS_INVALIDAS", "E-mail ou senha incorretos.");
      if (row.status === "inativo") fail(403, "ALUNO_INATIVO", "Cadastro inativo.");
      const result = await db.transaction(async (tx) => {
        const current = await one(
          tx,
          `SELECT ${userColumns},password_hash FROM users WHERE id=$1 FOR UPDATE`,
          [row.id],
        );
        if (!current || current.password_hash !== row.password_hash)
          fail(401, "CREDENCIAIS_INVALIDAS", "E-mail ou senha incorretos.");
        if (current.status === "inativo") fail(403, "ALUNO_INATIVO", "Cadastro inativo.");
        const { password_hash: _, ...user } = current;
        return session(tx, config, user as User, r);
      });
      reply.setCookie(cookieName, result.token, cookieOptions(config));
      return result.response;
    },
  );
  route(app, ctx, "POST", "/auth/refresh", { role: "public" }, async (r, reply) => {
    origin(r, config);
    await limit(db, `refresh:${r.ip}`, 60);
    const token = r.cookies[cookieName];
    if (!token) fail(401, "NAO_AUTENTICADO", "Sessão ausente.");
    const result = await db.transaction(async (tx) => {
      // Always lock user before refresh rows, matching password/status changes.
      const candidate = await one(tx, "SELECT user_id FROM refresh_tokens WHERE token_hash=$1", [
        digest(token),
      ]);
      if (!candidate) return null;
      const user = await one<User>(tx, `SELECT ${userColumns} FROM users WHERE id=$1 FOR UPDATE`, [
        candidate.user_id,
      ]);
      const old = await one(
        tx,
        "SELECT *,expires_at>now() AS valid FROM refresh_tokens WHERE token_hash=$1 FOR UPDATE",
        [digest(token)],
      );
      if (!old || !user || user.status === "inativo") return null;
      if (old.revoked_at || !old.valid) {
        await tx.query(
          "UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1",
          [old.family_id],
        );
        return null;
      }
      const next = await session(tx, config, user, r, old.family_id);
      await tx.query(
        "UPDATE refresh_tokens SET revoked_at=now(),replaced_by=$2 WHERE token_id=$1",
        [old.token_id, next.tokenId],
      );
      return next;
    });
    if (!result) {
      reply.clearCookie(cookieName, cookieOptions(config));
      fail(401, "NAO_AUTENTICADO", "Sessão encerrada. Entre novamente.");
    }
    reply.setCookie(cookieName, result.token, cookieOptions(config));
    return result.response;
  });
  route(app, ctx, "POST", "/auth/logout", { role: "public" }, async (r, reply) => {
    origin(r, config);
    const refreshToken = r.cookies[cookieName];
    if (refreshToken)
      await db.transaction(async (tx) => {
        const current = await one(
          tx,
          "SELECT user_id,family_id FROM refresh_tokens WHERE token_hash=$1",
          [digest(refreshToken)],
        );
        if (!current) return;
        // Match refresh's lock order so logout also sees any token it just created.
        await tx.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [current.user_id]);
        await tx.query(
          "UPDATE refresh_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1",
          [current.family_id],
        );
      });
    reply.clearCookie(cookieName, cookieOptions(config));
    return reply.code(204).send();
  });
  route(app, ctx, "GET", "/auth/me", {}, async (r) => ({
    user: r.account,
    ...(r.account.role === "aluno"
      ? { perfil: await one(db, "SELECT * FROM aluno_profile WHERE user_id=$1", [r.account.id]) }
      : {}),
  }));
  route(
    app,
    ctx,
    "PATCH",
    "/auth/senha",
    { body: z.strictObject({ senha_atual: z.string().min(1).max(128), nova_senha: password }) },
    async (r, reply, b) => {
      await limit(db, `password:${r.account.id}`, 5);
      const newHash = await hashPassword(b.nova_senha);
      await db.transaction(async (tx) => {
        const current = await one(tx, "SELECT password_hash FROM users WHERE id=$1 FOR UPDATE", [
          r.account.id,
        ]);
        if (!(await verify(current.password_hash, b.senha_atual)))
          fail(401, "CREDENCIAIS_INVALIDAS", "Senha atual incorreta.");
        await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [r.account.id, newHash]);
        await tx.query(
          "UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL",
          [r.account.id],
        );
      });
      reply.clearCookie(cookieName, cookieOptions(config));
      return reply.code(204).send();
    },
  );
}
