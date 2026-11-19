import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { resolve } from "node:path";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Database } from "./db.js";
import { ApiFailure, type Context } from "./http.js";
import { authRoutes, makeAuth, limit } from "./auth.js";
import { alunosRoutes } from "./modules/alunos.js";
import { billingRoutes } from "./modules/billing.js";
import { attendanceRoutes } from "./modules/attendance.js";
import { storeRoutes } from "./modules/store.js";
import { reportRoutes } from "./modules/reports.js";
import { cadastroRoutes } from "./modules/cadastro.js";
import { convitesRoutes } from "./modules/convites.js";
import { perfilRoutes } from "./modules/perfil.js";
import { lojaRoutes } from "./modules/loja.js";
import { FOTO_MAX_BYTES, FOTO_MIMES } from "../../../src/lib/imagem.js";
import { presenceStream } from "./stream.js";

export async function buildApp(
  config: Config,
  db: Database,
  options: { logger?: boolean; stream?: boolean } = {},
) {
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            redact: ["req.headers.authorization", "req.headers.cookie", "res.headers.set-cookie"],
            serializers: {
              req: (r) => ({ method: r.method, url: r.url?.split("?")[0], remoteAddress: r.ip }),
            },
          },
    bodyLimit: 65536,
    requestTimeout: 15000,
    connectionTimeout: 30000,
    trustProxy:
      config.NODE_ENV === "production" ? (_address: string, hop: number) => hop === 0 : false,
  });
  app.decorateRequest("account");
  app.decorateRequest("tokenExp", 0);
  await app.register(cors, {
    origin: config.CORS_ORIGIN,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: false,
  });
  await app.register(cookie);
  app.addHook("onRequest", async (r, reply) => {
    if (r.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
      await limit(db, `ip:${r.ip}`, 600);
    }
  });
  app.setErrorHandler((error, _r, reply) => {
    if (error instanceof ApiFailure)
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      });
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados inválidos.",
          details: error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
      });
    const e = error as { code?: string; constraint?: string; statusCode?: number };
    const unique: Record<string, string> = {
      uq_users_email: "EMAIL_JA_CADASTRADO",
      uq_attendance_sessao_aberta: "CHECKIN_JA_ABERTO",
      uq_financeiro_competencia: "MENSALIDADE_DUPLICADA",
      uq_aluno_cpf: "CPF_JA_CADASTRADO",
    };
    if (e.code === "23505")
      return reply.code(409).send({
        error: {
          code: unique[e.constraint ?? ""] ?? "CONFLITO",
          message: "Já existe um registro com esses dados.",
        },
      });
    if (e.code === "P0002")
      return reply
        .code(404)
        .send({ error: { code: "NAO_ENCONTRADO", message: "Registro não encontrado." } });
    if (["23514", "23503", "22003", "22007", "22008", "22P02"].includes(e.code ?? ""))
      return reply.code(422).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Dados incompatíveis com as regras do cadastro.",
        },
      });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500)
      return reply
        .code(e.statusCode)
        .send({ error: { code: "VALIDATION_ERROR", message: "Requisição inválida." } });
    // Do not log pg detail/query values: they may contain credentials or personal data.
    app.log.error({ code: e.code ?? "INTERNAL", request_id: _r.id }, "Request failed");
    return reply
      .code(500)
      .send({ error: { code: "ERRO_INTERNO", message: "Não foi possível concluir a operação." } });
  });
  const health = async () => {
    await db.query("SELECT 1");
    return { status: "ok", db: "ok" };
  };
  app.get("/health", health);
  app.get("/api/v1/health", health);
  // Corpo binário só para fotos (perfil e produtos); o limite global de 64 KB
  // continua valendo para todo o resto.
  app.addContentTypeParser(
    [...FOTO_MIMES],
    { parseAs: "buffer", bodyLimit: FOTO_MAX_BYTES },
    (_r, body, done) => done(null, body),
  );
  const ctx: Context = { db, config, authenticate: makeAuth(db, config) };
  await authRoutes(app, ctx);
  alunosRoutes(app, ctx);
  billingRoutes(app, ctx);
  attendanceRoutes(app, ctx);
  storeRoutes(app, ctx);
  reportRoutes(app, ctx);
  cadastroRoutes(app, ctx);
  convitesRoutes(app, ctx);
  perfilRoutes(app, ctx);
  lojaRoutes(app, ctx);
  if (options.stream !== false) presenceStream(app, ctx);
  if (config.SERVE_WEB) {
    await app.register(staticFiles, { root: resolve("dist"), prefix: "/", index: "index.html" });
    app.setNotFoundHandler((r, reply) => {
      if (
        r.method === "GET" &&
        !r.url.startsWith("/api/") &&
        r.headers.accept?.includes("text/html")
      )
        return reply.sendFile("index.html");
      return reply
        .code(404)
        .send({ error: { code: "NAO_ENCONTRADO", message: "Rota não encontrada." } });
    });
  } else
    app.setNotFoundHandler((_r, reply) =>
      reply.code(404).send({ error: { code: "NAO_ENCONTRADO", message: "Rota não encontrada." } }),
    );
  return app;
}
