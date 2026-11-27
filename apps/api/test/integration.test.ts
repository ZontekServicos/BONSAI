import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import sharp from "sharp";
import { decodeJwt, SignJWT } from "jose";
import type { HTTPMethods } from "fastify";
import { buildApp } from "../src/app.js";
import { createDatabase, one, type Database } from "../src/db.js";
import { readConfig, type Config } from "../src/config.js";
import { hashPassword } from "../src/auth.js";
import { batch } from "../src/modules/billing.js";
import { daily } from "../src/jobs/service.js";

// The suite creates and removes only its own random schema in a dedicated test DB.
const testURL = process.env.TEST_DATABASE_URL;
if (!testURL) throw new Error("Set TEST_DATABASE_URL to a PostgreSQL database named bonsai_test.");
const url = new URL(testURL);
if (url.pathname !== "/bonsai_test") throw new Error("Tests require database bonsai_test.");
const schema = `bonsai_test_${randomUUID().replaceAll("-", "")}`;
url.searchParams.set("options", `-c search_path=${schema},public`);
let db: Database;
let app: Awaited<ReturnType<typeof buildApp>>;
let config: Config;
let admin: string;
let student: string;
let other: string;
let adminToken: string;
let studentToken: string;
let passwordHash: string;
let imagemWebp: Buffer;
let imagemJpeg: Buffer;
const password = "Correct-test-password-2026";
const origin = "http://localhost:8443";
async function request(
  method: HTTPMethods,
  path: string,
  body?: unknown,
  token = adminToken,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url: `/api/v1${path}`,
    headers: { origin, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
  });
}
async function user(email: string, role = "aluno") {
  const row = await one(
    db,
    "INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id",
    ["Pessoa Teste", email, passwordHash, role],
  );
  if (role === "aluno")
    await db.query(
      `INSERT INTO aluno_profile(user_id,modalidade,faixa,data_matricula,contato_emergencia_nome,
         contato_emergencia_parentesco,contato_emergencia_telefone)
       VALUES($1,'jiu_jitsu','Faixa branca','2020-01-01','Contato Teste','Mãe','5511900000000')`,
      [row.id],
    );
  return row.id as string;
}
async function debt(id = student, days = 10) {
  return one(
    db,
    "INSERT INTO financeiro(user_id,valor,data_vencimento) VALUES($1,'150.00',fn_hoje_sp()-$2::int) RETURNING *",
    [id, days],
  );
}
async function product(stock = 1, price = "12.10") {
  return one(
    db,
    "INSERT INTO inventory_product(nome,preco,estoque_atual,categoria) VALUES($1,$2,$3,'Lutas') RETURNING *",
    [`Luva ${randomUUID()}`, price, stock],
  );
}
beforeAll(async () => {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;
  [imagemWebp, imagemJpeg] = await Promise.all([
    sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .webp({ quality: 90 })
      .toBuffer(),
    sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } })
      .jpeg({ quality: 90 })
      .toBuffer(),
  ]);
  const adminDB = new pg.Client({ connectionString: testURL });
  await adminDB.connect();
  await adminDB.query("CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public");
  await adminDB.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await adminDB.query(`CREATE SCHEMA ${schema}`);
  await adminDB.end();
  config = readConfig({
    DATABASE_URL: url.toString(),
    JWT_ACCESS_SECRET: "a".repeat(40),
    JWT_QR_SECRET: "q".repeat(40),
    CORS_ORIGIN: origin,
    WHATSAPP_LOJA: "+55 (11) 99999-0000",
    PIX_CHAVE: "financeiro@academia.test",
    NODE_ENV: "test",
  });
  db = createDatabase(config);
  await db.query(await readFile("database/schema.sql", "utf8"));
  await db.query(await readFile("database/migrations/0002_runtime.sql", "utf8"));
  await db.query(await readFile("database/migrations/0003_search.sql", "utf8"));
  await db.query(await readFile("database/migrations/0004_papeis_modalidades.sql", "utf8"));
  await db.query(await readFile("database/migrations/0005_cadastro_aluno.sql", "utf8"));
  await db.query(await readFile("database/migrations/0006_ajustes_ficha_professor.sql", "utf8"));
  await db.query(await readFile("database/migrations/0007_convites.sql", "utf8"));
  await db.query(await readFile("database/migrations/0008_perfil_aluno.sql", "utf8"));
  await db.query(await readFile("database/migrations/0009_loja_catalogo.sql", "utf8"));
  await db.query(await readFile("database/migrations/0010_turmas.sql", "utf8"));
  app = await buildApp(config, db, { logger: false, stream: false });
  await app.ready();
  passwordHash = await hashPassword(password);
});
beforeEach(async () => {
  await db.query("TRUNCATE users,api_rate_limits RESTART IDENTITY CASCADE");
  admin = await user("admin@example.test", "admin");
  student = await user("student@example.test");
  other = await user("other@example.test");
  adminToken = (
    await request("POST", "/auth/login", { email: "admin@example.test", password }, "")
  ).json().access_token;
  studentToken = (
    await request("POST", "/auth/login", { email: "student@example.test", password }, "")
  ).json().access_token;
});
afterAll(async () => {
  await app?.close();
  await db?.close();
  const cleanup = new pg.Client({ connectionString: testURL });
  await cleanup.connect();
  await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await cleanup.end();
});
describe("authentication and contract", () => {
  it("rejects expired, forged and wrong-context access JWTs and trusts the database role", async () => {
    const claims = decodeJwt(studentToken);
    const key = new TextEncoder().encode(config.JWT_ACCESS_SECRET);
    const sign = (payload: typeof claims, secret = key, algorithm = "HS256") =>
      new SignJWT(payload).setProtectedHeader({ alg: algorithm }).sign(secret);
    const invalid = [
      await sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }),
      await sign({ ...claims, aud: "bonsai-reception" }),
      await sign({ ...claims, iss: "untrusted-issuer" }),
      await sign({ ...claims, typ: "carteirinha" }),
      await sign(claims, new TextEncoder().encode("wrong-signing-key".repeat(4))),
      await sign(claims, key, "HS384"),
    ];
    for (const token of invalid)
      expect((await request("GET", "/auth/me", undefined, token)).statusCode).toBe(401);
    const forgedRole = await sign({ ...claims, role: "admin" });
    expect((await request("GET", "/dashboard", undefined, forgedRole)).statusCode).toBe(403);
    expect((await request("GET", "/auth/me", undefined, forgedRole)).json().user.role).toBe(
      "aluno",
    );
  });
  it("denies student access across administrative modules and other-student graduation history", async () => {
    for (const path of [
      "/alunos",
      "/presencas",
      "/presencas/ativas",
      `/alunos/${other}/graduacoes`,
    ])
      expect((await request("GET", path, undefined, studentToken)).statusCode).toBe(403);
    for (const path of ["/alunos", "/presencas/check-in", "/carteirinha/validar", "/produtos"])
      expect((await request("POST", path, {}, studentToken)).statusCode).toBe(403);
    // Extra query parameters cannot switch the identity used by self-service routes.
    expect(
      (await request("GET", `/me/mensalidades?user_id=${other}`, undefined, studentToken))
        .statusCode,
    ).toBe(400);
  });
  it("requires the exact browser origin for cookie operations and sends protective headers", async () => {
    for (const path of ["/auth/refresh", "/auth/logout"])
      for (const untrusted of ["null", "https://attacker.test", `${origin}.attacker.test`])
        expect((await request("POST", path, undefined, "", { origin: untrusted })).statusCode).toBe(
          403,
        );
    const missingOrigin = await app.inject({ method: "POST", url: "/api/v1/auth/refresh" });
    expect(missingOrigin.statusCode).toBe(403);
    const response = await request("GET", "/auth/me", undefined, studentToken);
    expect(response.headers["access-control-allow-origin"]).toBe(origin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    const login = await request(
      "POST",
      "/auth/login",
      { email: "student@example.test", password },
      "",
    );
    expect(login.headers["set-cookie"]).toContain("HttpOnly");
    expect(login.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(login.headers["set-cookie"]).toContain("Path=/api/v1/auth");
  });
  it("never exposes password hashes and preserves dates, UUIDs and decimal strings", async () => {
    const me = await request("GET", "/auth/me", undefined, studentToken);
    expect(me.statusCode).toBe(200);
    expect(me.body).not.toContain("password_hash");
    const profile = await request("GET", "/me/perfil", undefined, studentToken);
    expect(profile.json().perfil.data_matricula).toBe("2020-01-01");
    expect(profile.json().id).toBe(student);
    await debt();
    const payments = await request("GET", "/me/mensalidades", undefined, studentToken);
    expect(payments.json()[0].valor).toBe("150.00");
    expect(payments.json()[0].data_vencimento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it("rejects role escalation, other-student access, malformed IDs and extra fields", async () => {
    expect((await request("GET", "/dashboard", undefined, studentToken)).statusCode).toBe(403);
    expect((await request("GET", `/alunos/${other}`, undefined, studentToken)).statusCode).toBe(
      403,
    );
    expect((await request("GET", "/alunos/not-a-uuid")).statusCode).toBe(400);
    expect(
      (
        await request("POST", "/alunos", {
          nome: "Teste",
          email: "new@example.test",
          senha_inicial: password,
          modalidade: "boxe",
          faixa: "Iniciante",
          role: "admin",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await request("GET", `/alunos?q=${encodeURIComponent("' OR 1=1; --")}`)).json().total,
    ).toBe(0);
  });
  it("rejects untrusted origins, wrong password, and enforces distributed login throttling", async () => {
    expect(
      (
        await request("POST", "/auth/login", { email: "admin@example.test", password }, "", {
          origin: "https://attacker.test",
        })
      ).statusCode,
    ).toBe(403);
    for (let n = 0; n < 5; n++)
      expect(
        (
          await request(
            "POST",
            "/auth/login",
            { email: "unknown@example.test", password: "wrong" },
            "",
          )
        ).statusCode,
      ).toBe(401);
    expect(
      (
        await request(
          "POST",
          "/auth/login",
          { email: "unknown@example.test", password: "wrong" },
          "",
        )
      ).statusCode,
    ).toBe(429);
  });
  it("rotates refresh tokens and commits replay revocation", async () => {
    const login = await request(
      "POST",
      "/auth/login",
      { email: "student@example.test", password },
      "",
    );
    const cookie = login.cookies[0];
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    const refresh = await request("POST", "/auth/refresh", undefined, "", {
      cookie: `${cookie.name}=${cookie.value}`,
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.cookies[0].value).not.toBe(cookie.value);
    expect(
      (
        await request("POST", "/auth/refresh", undefined, "", {
          cookie: `${cookie.name}=${cookie.value}`,
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (await request("GET", "/auth/me", undefined, refresh.json().access_token)).statusCode,
    ).toBe(401);
  });
  it("never leaves a live session when refresh races with logout", async () => {
    const login = await request(
      "POST",
      "/auth/login",
      { email: "other@example.test", password },
      "",
    );
    const cookie = login.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}` };
    const [rotated, ended] = await Promise.all([
      request("POST", "/auth/refresh", undefined, "", headers),
      request("POST", "/auth/logout", undefined, "", headers),
    ]);
    expect(ended.statusCode).toBe(204);
    expect([200, 401]).toContain(rotated.statusCode);
    expect(
      (
        await one(
          db,
          "SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL",
          [other],
        )
      ).n,
    ).toBe(0);
    if (rotated.statusCode === 200)
      expect(
        (await request("GET", "/auth/me", undefined, rotated.json().access_token)).statusCode,
      ).toBe(401);
  });
  it("revokes access tokens on logout, password changes and administrative deactivation", async () => {
    const login = await request(
      "POST",
      "/auth/login",
      { email: "student@example.test", password },
      "",
    );
    const c = login.cookies[0];
    expect(
      (await request("POST", "/auth/logout", undefined, "", { cookie: `${c.name}=${c.value}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await request("GET", "/auth/me", undefined, login.json().access_token)).statusCode,
    ).toBe(401);
    expect(
      (
        await request(
          "PATCH",
          "/auth/senha",
          { senha_atual: password, nova_senha: "New-password-for-test" },
          studentToken,
        )
      ).statusCode,
    ).toBe(204);
    expect((await request("GET", "/auth/me", undefined, studentToken)).statusCode).toBe(401);
    expect(
      (await request("PATCH", `/alunos/${student}/status`, { status: "inativo" })).statusCode,
    ).toBe(200);
    expect(
      (
        await request(
          "POST",
          "/auth/login",
          { email: "student@example.test", password: "New-password-for-test" },
          "",
        )
      ).statusCode,
    ).toBe(403);
  });
});
describe("card, attendance and billing", () => {
  it("allows login while delinquent, blocks an already-issued QR, and unlocks on payment", async () => {
    const card = (await request("GET", "/me/carteirinha", undefined, studentToken)).json();
    expect(card.qr_token).toBeTruthy();
    await debt();
    expect(
      (await request("POST", "/auth/login", { email: "student@example.test", password }, ""))
        .statusCode,
    ).toBe(200);
    const blocked = await request("GET", "/me/carteirinha", undefined, studentToken);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.details.total_devido).toBe("150.00");
    expect(
      (await request("POST", "/carteirinha/validar", { qr_token: card.qr_token })).json().liberado,
    ).toBe(false);
    expect((await request("POST", "/presencas/check-in", { user_id: student })).statusCode).toBe(
      403,
    );
    const f = await one(db, "SELECT payment_id FROM financeiro WHERE user_id=$1", [student]);
    const paid = await request("PATCH", `/mensalidades/${f.payment_id}/pagar`, {
      metodo_pagamento: "pix",
    });
    expect(paid.statusCode).toBe(200);
    expect(paid.json().status_aluno).toBe("ativo");
    expect((await request("GET", "/me/carteirinha", undefined, studentToken)).statusCode).toBe(200);
    expect((await one(db, "SELECT count(*)::int AS n FROM cash_flow")).n).toBe(1);
  });
  it("respects grace boundary and separates access JWT from card JWT", async () => {
    await debt(student, 5);
    expect((await request("GET", "/me/carteirinha", undefined, studentToken)).statusCode).toBe(200);
    expect(
      (await request("POST", "/presencas/check-in", { qr_token: studentToken })).statusCode,
    ).toBe(400);
    const card = (await request("GET", "/me/carteirinha", undefined, studentToken)).json();
    expect((await request("GET", "/auth/me", undefined, card.qr_token)).statusCode).toBe(401);
  });
  it("serializes concurrent check-ins and increments attendance once", async () => {
    const responses = await Promise.all([
      request("POST", "/presencas/check-in", { user_id: student }),
      request("POST", "/presencas/check-in", { user_id: student }),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      (await one(db, "SELECT total_presencas FROM aluno_profile WHERE user_id=$1", [student]))
        .total_presencas,
    ).toBe(1);
    expect((await request("PATCH", "/presencas/check-out", { user_id: student })).statusCode).toBe(
      200,
    );
    expect((await request("PATCH", "/presencas/check-out", { user_id: student })).statusCode).toBe(
      409,
    );
  });
  it("prevents double payment under concurrency and keeps the ledger immutable", async () => {
    const f = await debt();
    const res = await Promise.all([
      request("PATCH", `/mensalidades/${f.payment_id}/pagar`, { metodo_pagamento: "pix" }),
      request("PATCH", `/mensalidades/${f.payment_id}/pagar`, { metodo_pagamento: "dinheiro" }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await one(db, "SELECT count(*)::int AS n FROM cash_flow")).n).toBe(1);
    expect((await request("DELETE", `/mensalidades/${f.payment_id}`)).statusCode).toBe(409);
    await expect(db.query("UPDATE cash_flow SET valor=1")).rejects.toMatchObject({ code: "23001" });
  });
  it("generates leap-day bills idempotently and preserves inactive users in the daily job", async () => {
    const b = { competencia: "2028-02", dia_vencimento: 31, valor_padrao: "125.50" };
    expect(await db.transaction((tx) => batch(tx, b))).toEqual({ criadas: 2, ignoradas: 0 });
    expect(await db.transaction((tx) => batch(tx, b))).toEqual({ criadas: 0, ignoradas: 2 });
    expect((await one(db, "SELECT data_vencimento FROM financeiro LIMIT 1")).data_vencimento).toBe(
      "2028-02-29",
    );
    await debt(student, 10);
    await db.query("UPDATE users SET status='inativo' WHERE id=$1", [other]);
    await db.query("INSERT INTO attendance(user_id,check_in) VALUES($1,now()-interval '5 hours')", [
      student,
    ]);
    await daily(db, config);
    await daily(db, config);
    expect((await one(db, "SELECT status FROM users WHERE id=$1", [student])).status).toBe(
      "inadimplente",
    );
    expect((await one(db, "SELECT status FROM users WHERE id=$1", [other])).status).toBe("inativo");
    expect((await one(db, "SELECT fechado_auto FROM attendance")).fechado_auto).toBe(true);
  });
  it("atomically creates a student with initial bills and records promotion history", async () => {
    const created = await request("POST", "/alunos", {
      nome: "Nova Aluna",
      email: "new@example.test",
      senha_inicial: password,
      modalidade: "muay_thai",
      nivel: "Iniciante",
      data_matricula: "2026-01-31",
      contato_emergencia: { nome: "Contato Teste", parentesco: "Pai", telefone: "11988887777" },
      gerar_mensalidades: { valor: "120.00", dia_vencimento: 31, meses: 3 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(
      (await one(db, "SELECT count(*)::int AS n FROM financeiro WHERE user_id=$1", [id])).n,
    ).toBe(3);
    expect(
      (await request("POST", `/alunos/${id}/graduacoes`, { nivel_novo: "Intermediário" }))
        .statusCode,
    ).toBe(201);
    expect((await request("GET", `/alunos/${id}`)).json().perfil).toMatchObject({
      nivel: "intermediario",
      faixa: "Intermediário",
      graduacao_nivel: 0,
    });
  });
});
describe("stock, cash and reports", () => {
  it("serves the built React app and rejects static path traversal", async () => {
    const web = await buildApp({ ...config, SERVE_WEB: true }, db, {
      logger: false,
      stream: false,
    });
    try {
      const response = await web.inject({ url: "/", headers: { accept: "text/html" } });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<div id="root">');
      expect(response.headers["content-security-policy"]).toContain("object-src 'none'");
      for (const path of [
        "/api/no-such-route",
        "/.env",
        "/..%2Fpackage.json",
        "/%2e%2e/database/schema.sql",
      ])
        expect((await web.inject({ url: path })).statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await web.close();
    }
  });
  it("broadcasts committed presence through PostgreSQL LISTEN and closes SSE clients", async () => {
    const live = await buildApp(config, db, { logger: false, stream: true });
    const abort = new AbortController();
    try {
      const address = await live.listen({ host: "127.0.0.1", port: 0 });
      const response = await fetch(`${address}/api/v1/presencas/stream`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      await reader.read();
      expect((await request("POST", "/presencas/check-in", { user_id: student })).statusCode).toBe(
        201,
      );
      const event = await reader.read();
      const data = new TextDecoder()
        .decode(event.value)
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(JSON.parse(data!.slice(6))).toMatchObject({ evento: "check_in", user_id: student });
      abort.abort();
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    } finally {
      abort.abort();
      await live.close();
    }
  });
  it("sells the last unit only once across concurrent transactions", async () => {
    const p = await product();
    const body = {
      user_id: student,
      metodo_pagamento: "pix",
      itens: [{ product_id: p.product_id, quantidade: 1 }],
    };
    const res = await Promise.all([
      request("POST", "/vendas", body, adminToken, { "idempotency-key": randomUUID() }),
      request("POST", "/vendas", body, adminToken, { "idempotency-key": randomUUID() }),
    ]);
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      (
        await one(db, "SELECT estoque_atual FROM inventory_product WHERE product_id=$1", [
          p.product_id,
        ])
      ).estoque_atual,
    ).toBe(0);
    expect((await one(db, "SELECT count(*)::int AS n FROM cash_flow")).n).toBe(1);
  });
  it("replays concurrent identical sales without another stock or cash mutation", async () => {
    const p = await product(10, "0.10");
    const body = {
      user_id: student,
      metodo_pagamento: "pix",
      itens: [{ product_id: p.product_id, quantidade: 3 }],
    };
    const key = randomUUID();
    const res = await Promise.all([
      request("POST", "/vendas", body, adminToken, { "idempotency-key": key }),
      request("POST", "/vendas", body, adminToken, { "idempotency-key": key }),
    ]);
    expect(res.map((r) => r.statusCode)).toEqual([201, 201]);
    expect(res[0].json()).toEqual(res[1].json());
    expect(res[0].json().total).toBe("0.30");
    expect(
      (
        await one(db, "SELECT estoque_atual FROM inventory_product WHERE product_id=$1", [
          p.product_id,
        ])
      ).estoque_atual,
    ).toBe(7);
    expect(
      (
        await request(
          "POST",
          "/vendas",
          { ...body, itens: [{ product_id: p.product_id, quantidade: 2 }] },
          adminToken,
          { "idempotency-key": key },
        )
      ).statusCode,
    ).toBe(409);
  });
  it("rolls back the full cart when an item fails and validates inventory adjustments", async () => {
    const products = [await product(5), await product(5)].sort((a, b) =>
      a.product_id.localeCompare(b.product_id),
    );
    const [p, empty] = products;
    await db.query("UPDATE inventory_product SET estoque_atual=0 WHERE product_id=$1", [
      empty.product_id,
    ]);
    const body = {
      user_id: student,
      metodo_pagamento: "pix",
      itens: [
        { product_id: p.product_id, quantidade: 1 },
        { product_id: empty.product_id, quantidade: 1 },
      ],
    };
    expect(
      (await request("POST", "/vendas", body, adminToken, { "idempotency-key": randomUUID() }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await one(db, "SELECT estoque_atual FROM inventory_product WHERE product_id=$1", [
          p.product_id,
        ])
      ).estoque_atual,
    ).toBe(5);
    expect((await one(db, "SELECT count(*)::int AS n FROM loja_venda")).n).toBe(0);
    expect(
      (
        await request("PATCH", `/produtos/${p.product_id}/estoque`, {
          operacao: "ajuste",
          quantidade: -6,
          motivo: "Contagem",
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (
        await request("PATCH", `/produtos/${p.product_id}/estoque`, {
          operacao: "entrada",
          quantidade: 2,
          motivo: "Reposição",
        })
      ).statusCode,
    ).toBe(200);
    expect((await one(db, "SELECT count(*)::int AS n FROM inventory_movements")).n).toBe(1);
  });
  it("serves every report and reconciles withdrawals and incoming cash", async () => {
    expect(
      (
        await request("POST", "/caixa/lancamentos", {
          tipo: "entrada",
          valor: "250.00",
          motivo: "Saldo inicial",
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (await request("POST", "/caixa/sangrias", { valor: "40.00", motivo: "Depósito" })).statusCode,
    ).toBe(201);
    expect((await request("GET", "/caixa/balanco")).json().saldo).toBe("210.00");
    const now = await one(db, "SELECT fn_hoje_sp() AS dia,to_char(fn_hoje_sp(),'YYYY-MM') AS mes");
    for (const path of [
      "/dashboard",
      "/presencas/estatisticas",
      "/financeiro/inadimplentes",
      `/financeiro/resumo?competencia=${now.mes}`,
      `/caixa/balanco/periodo?de=${now.dia}&ate=${now.dia}`,
      "/presencas",
      "/presencas/ativas",
      "/vendas",
      "/produtos",
      "/alunos",
      "/caixa/lancamentos",
      "/mensalidades",
    ]) {
      const result = await request("GET", path);
      expect(result.statusCode, `${path}: ${result.body}`).toBe(200);
    }
    for (const path of [
      "/me/perfil",
      "/me/mensalidades",
      "/me/compras",
      "/me/graduacoes",
      "/me/presencas",
    ])
      expect((await request("GET", path, undefined, studentToken)).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Fase 1 — cadastro completo (ficha do professor) e papel professor
// ---------------------------------------------------------------------------
let cpfSeq = 100000000;
/** CPF de teste válido e único (dígitos verificadores calculados). */
function gerarCpf() {
  const dv = (d: number[]) => {
    const s = d.reduce((acc, n, i) => acc + n * (d.length + 1 - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const base = String(cpfSeq++).split("").map(Number);
  const d1 = dv(base);
  return [...base, d1, dv([...base, d1])].join("");
}
/** Data de hoje em America/Sao_Paulo (mesma regra do fn_hoje_sp). */
const todaySP = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const shift = (iso: string, years: number, days = 0) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
type Grupo = Record<string, unknown>;
type Ficha = {
  acesso: Grupo & { email: string };
  treino: Grupo;
  pessoal: Grupo & { cpf: string };
  [k: string]: unknown;
};
let seq = 0;
/** Payload válido na ordem da ficha; `o` sobrescreve campos de cada grupo. */
function cadastro(
  o: { acesso?: Grupo; treino?: Grupo; pessoal?: Grupo } = {},
  extra: Record<string, unknown> = {},
): Ficha {
  seq++;
  return {
    acesso: {
      nome: "Ana Lutadora",
      email: `ana${seq}@example.test`,
      senha_inicial: "senha-inicial-123",
      ...o.acesso,
    } as Grupo & { email: string },
    treino: {
      modalidade: "jiu_jitsu",
      faixa: "Faixa branca",
      grau: 1,
      data_matricula: "2025-02-10",
      professor_responsavel: "Prof. Teste",
      ...o.treino,
    },
    pessoal: {
      cpf: gerarCpf(),
      whatsapp: "(11) 98765-4321",
      data_nascimento: "1995-05-20",
      genero: "feminino",
      rg: "12.345.678-9",
      endereco: "Rua do Tatame, 10",
      bairro: "Centro",
      cidade: "São Paulo",
      cep: "01001-000",
      ...o.pessoal,
    } as Grupo & { cpf: string },
    contato_emergencia: {
      nome: "Carlos Contato",
      parentesco: "Irmão",
      telefone: "(11) 97777-6666",
    },
    saude: {
      tipo_sanguineo: "O+",
      condicoes_medicas: "Asma leve",
      lesoes_cronicas: "",
      medicacao_continua: null,
      artes_marciais_anteriores: "Judô",
    },
    termos: {
      aceito: true,
      versao: "2026-11",
      autoriza_uso_imagem: true,
      autoriza_grupo_whatsapp: false,
    },
    ...extra,
  };
}
const guardian = {
  nome: "Maria Responsável",
  parentesco: "mae",
  whatsapp: "11 91234-5678",
  telefone_emergencia: "(11) 3333-4444",
};
const count = async (table: string) =>
  Number((await one(db, `SELECT count(*)::int AS n FROM ${table}`)).n);

describe("student registration (phase 1) and professor role", () => {
  let professor: string;
  let professorToken: string;
  beforeEach(async () => {
    professor = await user("prof@example.test", "professor");
    professorToken = (
      await request("POST", "/auth/login", { email: "prof@example.test", password }, "")
    ).json().access_token;
  });
  const register = (body: unknown, token?: string) =>
    request("POST", "/alunos/cadastro", body, token ?? professorToken);

  it("registers an adult atomically from the paper form, normalizes input and restricts the record", async () => {
    const body = cadastro();
    const res = await register(body);
    expect(res.statusCode).toBe(201);
    const created = res.json();
    // dados operacionais da ficha do professor
    expect(created.perfil).toMatchObject({
      modalidade: "jiu_jitsu",
      faixa: "Faixa branca",
      graduacao_nivel: 1,
      nivel: null,
      data_matricula: "2025-02-10",
    });
    expect(created.ficha).toMatchObject({
      cpf: body.pessoal.cpf,
      cep: "01001000",
      whatsapp: "5511987654321",
      professor_responsavel: "Prof. Teste",
      menor_de_idade: false,
      responsavel: null,
      contato_emergencia: {
        nome: "Carlos Contato",
        parentesco: "Irmão",
        telefone: "5511977776666",
        telefone2: null,
      },
      termos_aceitos: true,
      termos_versao: "2026-11",
      ficha_pendente: false,
      autoriza_uso_imagem: true,
      autoriza_grupo_whatsapp: false,
      contato_principal: { whatsapp: "5511987654321", origem: "aluno" },
    });
    expect(created.ficha.idade).toBeGreaterThanOrEqual(31);
    expect(created.ficha.saude).toMatchObject({
      tipo_sanguineo: "O+",
      lesoes_cronicas: null,
      atualizado_por: professor,
    });
    // dado sensível: outro aluno não vê; o próprio aluno e o staff veem
    const path = `/alunos/${created.id}/ficha`;
    expect((await request("GET", path, undefined, studentToken)).statusCode).toBe(403);
    expect((await request("GET", path)).statusCode).toBe(200);
    const own = (
      await request(
        "POST",
        "/auth/login",
        { email: created.email, password: "senha-inicial-123" },
        "",
      )
    ).json().access_token;
    expect((await request("GET", path, undefined, own)).statusCode).toBe(200);
    // listagem nunca carrega CPF nem saúde
    const list = (await request("GET", "/alunos?page_size=100")).body;
    expect(list).not.toContain(body.pessoal.cpf);
    expect(list).not.toContain("Asma leve");
  });

  it("requires a guardian for minors, falls back to the guardian WhatsApp and links siblings", async () => {
    const minor = {
      pessoal: { data_nascimento: shift(todaySP(), -12), whatsapp: null },
      treino: { data_matricula: todaySP() },
    };
    const missing = await register(cadastro(minor));
    expect(missing.statusCode).toBe(400);
    expect(JSON.stringify(missing.json().error.details)).toContain("responsavel");

    const first = await register(cadastro(minor, { responsavel: guardian }));
    expect(first.statusCode).toBe(201);
    const f = first.json().ficha;
    expect(f.menor_de_idade).toBe(true);
    expect(f.idade).toBe(12);
    expect(f.responsavel).toMatchObject({
      nome: "Maria Responsável",
      whatsapp: "5511912345678",
      telefone_emergencia: "551133334444",
    });
    expect(f.contato_principal).toEqual({ whatsapp: "5511912345678", origem: "responsavel" });

    const sibling = await register(cadastro(minor, { responsavel: { id: f.responsavel.id } }));
    expect(sibling.statusCode).toBe(201);
    expect(sibling.json().ficha.responsavel.id).toBe(f.responsavel.id);
    const search = (
      await request("GET", "/responsaveis?q=maria", undefined, professorToken)
    ).json();
    expect(search.data).toEqual([expect.objectContaining({ id: f.responsavel.id, alunos: 2 })]);
    // busca por nome sem dígitos não pode casar com todos pelo telefone
    expect(
      (await request("GET", "/responsaveis?q=zzz", undefined, professorToken)).json().total,
    ).toBe(0);
    const ghost = await register(cadastro(minor, { responsavel: { id: randomUUID() } }));
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().error.code).toBe("RESPONSAVEL_NAO_ENCONTRADO");
  });

  it("treats the 18th birthday as adult (America/Sao_Paulo date)", async () => {
    const at18 = shift(todaySP(), -18);
    const adult = await register(
      cadastro({ pessoal: { data_nascimento: at18 }, treino: { data_matricula: todaySP() } }),
    );
    expect(adult.statusCode).toBe(201);
    expect(adult.json().ficha.menor_de_idade).toBe(false);
    const dayBefore18 = shift(todaySP(), -18, 1);
    expect(
      (
        await register(
          cadastro({
            pessoal: { data_nascimento: dayBefore18 },
            treino: { data_matricula: todaySP() },
          }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it("enforces the enrollment date and modality rules of the professor's form", async () => {
    const tomorrow = shift(todaySP(), 0, 1);
    for (const treino of [
      { data_matricula: tomorrow },
      { data_matricula: "1990-01-01" }, // antes do nascimento (1995)
      { data_matricula: undefined },
      { modalidade: "karate" },
      { modalidade: undefined },
      { faixa: "" },
      { grau: undefined },
      { grau: -1 },
    ]) {
      const res = await register(cadastro({ treino }));
      expect(res.statusCode, JSON.stringify(treino)).toBe(400);
    }
    const bad = (await register(cadastro({ treino: { modalidade: "karate" } }))).json();
    expect(JSON.stringify(bad.error.details)).toContain("boxe, jiu_jitsu, muay_thai, mma");
    // hoje é válido
    expect((await register(cadastro({ treino: { data_matricula: todaySP() } }))).statusCode).toBe(
      201,
    );
    // cadastro simples (legado) também recusa matrícula futura
    const legacy = await request("POST", "/alunos", {
      nome: "Legado Futuro",
      email: "legado.futuro@example.test",
      senha_inicial: password,
      modalidade: "boxe",
      nivel: "iniciante",
      data_matricula: tomorrow,
      contato_emergencia: { nome: "Contato Teste", parentesco: "Pai", telefone: "11988887777" },
    });
    expect(legacy.statusCode).toBe(400);
    // última linha de defesa no banco
    await expect(
      db.query("UPDATE aluno_profile SET data_matricula=fn_hoje_sp()+1 WHERE user_id=$1", [
        student,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_matricula" });
  });

  it("requires emergency contact and explicit image/WhatsApp-group answers", async () => {
    const base = cadastro();
    for (const extra of [
      { contato_emergencia: undefined },
      { contato_emergencia: { nome: "X Y", parentesco: "Irmão", telefone: "123" } },
      { termos: { aceito: true, versao: "2026-11", autoriza_uso_imagem: true } },
      {
        termos: {
          aceito: false,
          versao: "2026-11",
          autoriza_uso_imagem: true,
          autoriza_grupo_whatsapp: true,
        },
      },
    ]) {
      const res = await register({ ...base, ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(400);
    }
    const two = await register(
      cadastro(
        {},
        {
          contato_emergencia: {
            nome: "Carlos Contato",
            parentesco: "Irmão",
            telefone: "11977776666",
            telefone2: "(11) 3222-1111",
          },
        },
      ),
    );
    expect(two.statusCode).toBe(201);
    expect(two.json().ficha.contato_emergencia.telefone2).toBe("551132221111");
  });

  it("rolls back the new guardian and user when a later step fails", async () => {
    const taken = cadastro();
    expect((await register(taken)).statusCode).toBe(201);
    const before = [await count("responsaveis"), await count("users")];
    const dupCpf = await register(
      cadastro(
        {
          pessoal: { cpf: taken.pessoal.cpf, data_nascimento: shift(todaySP(), -10) },
          treino: { data_matricula: todaySP() },
        },
        { responsavel: guardian },
      ),
    );
    expect(dupCpf.statusCode).toBe(409);
    expect(dupCpf.json().error.code).toBe("CPF_JA_CADASTRADO");
    const dupEmail = await register(
      cadastro({ acesso: { email: taken.acesso.email } }, { responsavel: guardian }),
    );
    expect(dupEmail.statusCode).toBe(409);
    expect(dupEmail.json().error.code).toBe("EMAIL_JA_CADASTRADO");
    expect([await count("responsaveis"), await count("users")]).toEqual(before);
  });

  it("rejects invalid input and enforces CPF, minor and terms rules in the database", async () => {
    for (const pessoal of [
      { cpf: "111.111.111-11" },
      { cpf: "529.982.247-26" },
      { data_nascimento: shift(todaySP(), 0, 1) },
      { cep: "123" },
      { whatsapp: "123" },
    ])
      expect((await register(cadastro({ pessoal }))).statusCode, JSON.stringify(pessoal)).toBe(400);
    // formato antigo (tudo dentro de "aluno") não é mais aceito
    expect((await register({ aluno: cadastro().pessoal })).statusCode).toBe(400);
    // última linha de defesa: mesmo por SQL direto
    await expect(
      db.query("UPDATE aluno_profile SET data_nascimento=fn_hoje_sp()-3650 WHERE user_id=$1", [
        student,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE aluno_profile SET cpf='12345678900' WHERE user_id=$1", [student]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query("UPDATE aluno_profile SET termos_aceitos=true WHERE user_id=$1", [student]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.query(
        `UPDATE aluno_profile SET termos_aceitos=true, termos_aceitos_em=now(), termos_versao='x'
          WHERE user_id=$1`,
        [student],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_autorizacoes" });
    await expect(
      db.query("UPDATE aluno_profile SET contato_emergencia_telefone=NULL WHERE user_id=$1", [
        student,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_emergencia_obrigatoria" });
  });

  it("uses belt + degree for Jiu-Jitsu and Iniciante/Intermediário/Avançado for other modalities", async () => {
    // Boxe: nível aceito com ou sem acento; faixa espelha o rótulo; grau = 0
    const boxe = await register(
      cadastro({
        treino: { modalidade: "boxe", faixa: undefined, grau: undefined, nivel: "Intermediário" },
      }),
    );
    expect(boxe.statusCode).toBe(201);
    expect(boxe.json().perfil).toMatchObject({
      modalidade: "boxe",
      nivel: "intermediario",
      faixa: "Intermediário",
      graduacao_nivel: 0,
    });
    const semFaixa = { faixa: undefined, grau: undefined };
    for (const treino of [
      { modalidade: "boxe", ...semFaixa }, // sem nível
      { modalidade: "muay_thai", ...semFaixa, nivel: "Expert" }, // fora da lista
      { modalidade: "mma", grau: undefined, nivel: "avancado" }, // faixa em modalidade de nível
      { modalidade: "boxe", faixa: undefined, nivel: "avancado" }, // grau em modalidade de nível
      { modalidade: "jiu_jitsu", nivel: "avancado" }, // nível no Jiu-Jitsu
      { modalidade: "jiu_jitsu", faixa: undefined }, // Jiu-Jitsu sem faixa
    ]) {
      const res = await register(cadastro({ treino }));
      expect(res.statusCode, JSON.stringify(treino)).toBe(400);
    }
    const id = boxe.json().id;
    // promoção respeita a modalidade atual
    const promo = (b: unknown) => request("POST", `/alunos/${id}/graduacoes`, b, professorToken);
    expect((await promo({ faixa_nova: "Azul", graduacao_nova: 1 })).statusCode).toBe(400);
    const up = await promo({ nivel_novo: "Avançado" });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ faixa_nova: "Avançado", graduacao_nova: 0 });
    // troca de modalidade exige a graduação da nova modalidade
    const patch = (b: unknown) => request("PATCH", `/alunos/${id}`, b);
    expect((await patch({ modalidade: "jiu_jitsu" })).statusCode).toBe(400);
    expect((await patch({ faixa: "Azul", grau: 1 })).statusCode).toBe(400);
    const jj = await patch({ modalidade: "jiu_jitsu", faixa: "Azul", grau: 1 });
    expect(jj.statusCode).toBe(200);
    expect(jj.json().perfil).toMatchObject({ faixa: "Azul", graduacao_nivel: 1, nivel: null });
    // banco: Jiu-Jitsu não aceita nível; outras modalidades exigem nível
    await expect(
      db.query("UPDATE aluno_profile SET nivel='iniciante' WHERE user_id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_nivel_modalidade" });
    await expect(
      db.query("UPDATE aluno_profile SET modalidade='boxe' WHERE user_id=$1", [id]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_nivel_modalidade" });
  });

  it("makes the emergency contact mandatory in every creation path (BLK-02)", async () => {
    const legado = {
      nome: "Legado",
      email: "legado.emergencia@example.test",
      senha_inicial: password,
      modalidade: "jiu_jitsu",
      faixa: "Branca",
      grau: 0,
    };
    expect((await request("POST", "/alunos", legado)).statusCode).toBe(400);
    const ok = await request("POST", "/alunos", {
      ...legado,
      contato_emergencia: { nome: "Mãe Legado", parentesco: "Mãe", telefone: "(11) 95555-4444" },
    });
    expect(ok.statusCode).toBe(201);
    const ficha = (await request("GET", `/alunos/${ok.json().id}/ficha`)).json().ficha;
    expect(ficha).toMatchObject({
      ficha_pendente: false,
      contato_emergencia: { nome: "Mãe Legado", telefone: "5511955554444" },
    });
    // SQL direto: perfil novo sem emergência é recusado, e não dá para "se marcar" legado
    const u = await one(
      db,
      "INSERT INTO users(nome,email,password_hash,role) VALUES('Sem Contato','sem@example.test','x','aluno') RETURNING id",
    );
    await expect(
      db.query(
        "INSERT INTO aluno_profile(user_id,modalidade,faixa) VALUES($1,'jiu_jitsu','Branca')",
        [u.id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_emergencia_obrigatoria" });
    await expect(
      db.query(
        "INSERT INTO aluno_profile(user_id,modalidade,faixa,ficha_pendente) VALUES($1,'jiu_jitsu','Branca',true)",
        [u.id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_emergencia_obrigatoria" });
  });

  it("gives professors students, graduations and attendance but no finance, cash, store or dashboard", async () => {
    for (const path of [
      "/alunos",
      `/alunos/${student}/graduacoes`,
      "/presencas/ativas",
      "/presencas",
      "/presencas/estatisticas",
      "/responsaveis",
    ])
      expect((await request("GET", path, undefined, professorToken)).statusCode, path).toBe(200);
    const detail = await request("GET", `/alunos/${student}`, undefined, professorToken);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).not.toHaveProperty("situacao_financeira");
    const checkIn = await request(
      "POST",
      "/presencas/check-in",
      { user_id: student },
      professorToken,
    );
    expect(checkIn.statusCode).toBe(201);
    const promote = await request(
      "POST",
      `/alunos/${student}/graduacoes`,
      { faixa_nova: "Faixa azul", graduacao_nova: 0 },
      professorToken,
    );
    expect(promote.statusCode).toBe(201);
    for (const [method, path, body] of [
      ["GET", "/dashboard"],
      ["GET", "/mensalidades"],
      ["GET", "/financeiro/resumo"],
      ["GET", "/financeiro/inadimplentes"],
      ["GET", "/caixa/balanco"],
      ["GET", "/caixa/lancamentos"],
      ["GET", "/vendas"],
      ["POST", "/produtos", { nome: "X", preco: "1.00", estoque_atual: 1, categoria: "x" }],
      ["POST", "/alunos", {}],
      ["PATCH", `/alunos/${student}/status`, { status: "inativo" }],
      ["GET", "/professores"],
    ] as [HTTPMethods, string, unknown?][])
      expect(
        (await request(method, path, body, professorToken)).statusCode,
        `${method} ${path}`,
      ).toBe(403);
    // aluno não cadastra nem consulta responsáveis
    expect((await register(cadastro(), studentToken)).statusCode).toBe(403);
    expect((await request("GET", "/responsaveis", undefined, studentToken)).statusCode).toBe(403);
  });

  it("lets only admins manage professor accounts and revokes sessions on deactivation", async () => {
    const created = await request("POST", "/professores", {
      nome: "Prof Novo",
      email: "novo.prof@example.test",
      senha_inicial: "senha-forte-1234",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ role: "professor", status: "ativo" });
    expect(created.json()).not.toHaveProperty("password_hash");
    const token = (
      await request(
        "POST",
        "/auth/login",
        { email: "novo.prof@example.test", password: "senha-forte-1234" },
        "",
      )
    ).json().access_token;
    expect((await request("GET", "/auth/me", undefined, token)).json().user.role).toBe("professor");
    expect((await request("GET", "/professores")).json()).toHaveLength(2);
    const off = await request("PATCH", `/professores/${created.json().id}/status`, {
      status: "inativo",
    });
    expect(off.statusCode).toBe(200);
    expect((await request("GET", "/auth/me", undefined, token)).statusCode).not.toBe(200);
    // a rota de professores não altera alunos
    const wrong = await request("PATCH", `/professores/${student}/status`, { status: "inativo" });
    expect(wrong.statusCode).toBe(404);
  });
});

describe("migrations", () => {
  it("never changes a published migration (checksums of the deployed files)", async () => {
    const { createHash } = await import("node:crypto");
    const published: Record<string, string> = {
      "schema.sql": "292e0a9db5615cc5729d25109382a0226fdb213dd91d32f15168a30b8eca11f7",
      "migrations/0002_runtime.sql":
        "e87aa24d6ee1923c6576b55f9bc465af84f9b64dc74627ece42033a3c242458e",
      "migrations/0003_search.sql":
        "715febe997596745076107a10766f08ce908523fb588ce04a72313a31ed123c1",
      "migrations/0004_papeis_modalidades.sql":
        "0638c6b4726347402fcd2f0137a3ef70a046d235712a4f356a9b956c45655c66",
      // 0005 publicada no commit 54e215e
      "migrations/0005_cadastro_aluno.sql":
        "0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3",
      // 0006 aprovada na auditoria final de 19/11/2026
      "migrations/0006_ajustes_ficha_professor.sql":
        "becde7ebd4cef4f92a70107e93bda1436b5221293fb58d56c0e73fa8df54a24c",
      // 0007 publicada em 8e24743
      "migrations/0007_convites.sql":
        "588dbb3d50dfd4a51f8da5f74ba66e92601446b39bfd01bed7c99d1d632a06f7",
      // 0008 publicada em ef093ad
      "migrations/0008_perfil_aluno.sql":
        "1162c62a2a9bdc1583e9336afacfd45c0909a3717d0ab3d38246a23a1e59b9f1",
      // 0009 publicada em 2a3ae6d
      "migrations/0009_loja_catalogo.sql":
        "bb83a8bf49e7835befe69399a5b27752798f1fd91355dbd225099893db0f617f",
    };
    for (const [name, sum] of Object.entries(published)) {
      const raw = (await readFile(`database/${name}`, "utf8")).replace(/\r\n/g, "\n");
      expect(createHash("sha256").update(raw).digest("hex"), name).toBe(sum);
    }
  });

  it("upgrades a 0005 database: legacy profiles become pending, keep working and can be completed", async () => {
    const up = `bonsai_upgrade_${randomUUID().replaceAll("-", "")}`;
    const c = new pg.Client({ connectionString: testURL });
    await c.connect();
    try {
      await c.query(`CREATE SCHEMA ${up}`);
      // pg_trgm foi instalada no schema da suíte; deixa-o visível depois do novo.
      await c.query(`SET search_path=${up},${schema},public`);
      for (const name of [
        "schema.sql",
        "migrations/0002_runtime.sql",
        "migrations/0003_search.sql",
        "migrations/0004_papeis_modalidades.sql",
        "migrations/0005_cadastro_aluno.sql",
      ])
        await c.query(await readFile(`database/${name}`, "utf8"));
      // Estado de produção na 0005: um aluno de Jiu-Jitsu e um de Boxe sem contato.
      const ids: Record<string, string> = {};
      for (const [k, modalidade, faixa] of [
        ["jj", "jiu_jitsu", "Azul"],
        ["boxe", "boxe", "Iniciante"],
      ]) {
        ids[k] = (
          await c.query(
            `INSERT INTO users(nome,email,password_hash,role) VALUES($1,$2,'x','aluno') RETURNING id`,
            [k, `${k}@legado.test`],
          )
        ).rows[0].id;
        await c.query("INSERT INTO aluno_profile(user_id,modalidade,faixa) VALUES($1,$2,$3)", [
          ids[k],
          modalidade,
          faixa,
        ]);
      }
      await c.query(await readFile("database/migrations/0006_ajustes_ficha_professor.sql", "utf8"));
      const pend = async (id: string) =>
        (await c.query("SELECT * FROM aluno_profile WHERE user_id=$1", [id])).rows[0];
      expect((await pend(ids.jj)).ficha_pendente).toBe(true);
      expect((await pend(ids.boxe)).ficha_pendente).toBe(true);
      // legado continua operando (ex.: contador de presença)
      await c.query("UPDATE aluno_profile SET total_presencas=total_presencas+1 WHERE user_id=$1", [
        ids.jj,
      ]);
      // não dá para tirar a pendência sem completar a ficha
      await expect(
        c.query("UPDATE aluno_profile SET ficha_pendente=false WHERE user_id=$1", [ids.jj]),
      ).rejects.toMatchObject({ code: "23514" });
      const contato = `contato_emergencia_nome='Pai',contato_emergencia_parentesco='Pai',
        contato_emergencia_telefone='5511900000000'`;
      // Jiu-Jitsu: completar o contato encerra a pendência
      await c.query(`UPDATE aluno_profile SET ${contato} WHERE user_id=$1`, [ids.jj]);
      expect((await pend(ids.jj)).ficha_pendente).toBe(false);
      // …e depois o contato não pode mais ser removido
      await expect(
        c.query("UPDATE aluno_profile SET contato_emergencia_telefone=NULL WHERE user_id=$1", [
          ids.jj,
        ]),
      ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_emergencia_obrigatoria" });
      // Boxe: só o contato não basta; falta o nível
      await c.query(`UPDATE aluno_profile SET ${contato} WHERE user_id=$1`, [ids.boxe]);
      expect((await pend(ids.boxe)).ficha_pendente).toBe(true);
      await c.query("UPDATE aluno_profile SET nivel='avancado' WHERE user_id=$1", [ids.boxe]);
      expect(await pend(ids.boxe)).toMatchObject({
        ficha_pendente: false,
        faixa: "Avançado",
        graduacao_nivel: 0,
      });
    } finally {
      await c.query(`DROP SCHEMA IF EXISTS ${up} CASCADE`);
      await c.end();
    }
  });
});

// ---------------------------------------------------------------------------
// Convites (0007): link com token → ficha preenchida pelo próprio aluno
// ---------------------------------------------------------------------------
describe("registration invites", () => {
  let professorToken: string;
  beforeEach(async () => {
    await user("prof.convite@example.test", "professor");
    professorToken = (
      await request("POST", "/auth/login", { email: "prof.convite@example.test", password }, "")
    ).json().access_token;
  });
  const convidar = (email: string, extra: Record<string, unknown> = {}, token?: string) =>
    request("POST", "/convites", { email, ...extra }, token ?? professorToken);
  const tokenDe = (url: string) => new URL(url).searchParams.get("token")!;
  /** Ficha preenchida pelo aluno (sem e-mail: vem do convite). */
  const ficha = (o: Parameters<typeof cadastro>[0] = {}, extra: Record<string, unknown> = {}) => {
    const { acesso, ...resto } = cadastro(o);
    return {
      ...resto,
      acesso: { nome: acesso.nome, senha_inicial: acesso.senha_inicial },
      ...extra,
    };
  };
  const validar = (t: string) => request("GET", `/convites/validar/${t}`, undefined, "");
  const enviar = (t: string, body: unknown) => request("POST", `/convites/${t}/cadastro`, body, "");

  it("lets staff create a single-use link and stores only the token hash", async () => {
    const res = await convidar("novo.aluno@example.test", { whatsapp: "(11) 98888-7777" });
    expect(res.statusCode).toBe(201);
    const c = res.json();
    expect(c).toMatchObject({ email_destinatario: "novo.aluno@example.test", status: "pendente" });
    expect(c.url).toMatch(/\/cadastro\?token=[A-Za-z0-9_-]{43}$/);
    expect(c.whatsapp_url).toMatch(/^https:\/\/wa\.me\/5511988887777\?text=/);
    const token = tokenDe(c.url);
    const row = await one(db, "SELECT * FROM convites WHERE id=$1", [c.id]);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // validade padrão de 7 dias
    const dias =
      (new Date(row.data_expiracao).getTime() - new Date(row.created_at).getTime()) / 864e5;
    expect(dias).toBeCloseTo(7, 5);
    // admin também convida; aluno e anônimo não
    expect((await convidar("outro@example.test", {}, adminToken)).statusCode).toBe(201);
    expect((await convidar("x@example.test", {}, studentToken)).statusCode).toBe(403);
    expect((await convidar("y@example.test", {}, "")).statusCode).toBe(401);
    // e-mail que já tem conta não recebe convite
    const dup = await convidar("student@example.test");
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMAIL_JA_CADASTRADO");
    // listagem da equipe não expõe hash nem token
    const lista = await request("GET", "/convites", undefined, professorToken);
    expect(lista.json().total).toBe(2);
    expect(lista.body).not.toContain("token");
  });

  it("validates the link publicly and refuses unknown, malformed and revoked tokens", async () => {
    const primeiro = tokenDe((await convidar("ana.convite@example.test")).json().url);
    const ok = await validar(primeiro);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      email: "ana.convite@example.test",
      convidado_por: "Pessoa Teste",
    });
    for (const t of ["x".repeat(43), "curto", "a/b"]) {
      const r = await validar(encodeURIComponent(t));
      expect(r.statusCode, t).toBe(404);
      expect(r.json().error.code).toBe("CONVITE_INVALIDO");
    }
    // novo convite para o mesmo e-mail cancela o anterior
    const segundo = tokenDe((await convidar("ana.convite@example.test")).json().url);
    expect((await validar(primeiro)).json().error.code).toBe("CONVITE_REVOGADO");
    expect((await validar(segundo)).statusCode).toBe(200);
    // revogação manual
    const { id } = await one(
      db,
      "SELECT id FROM convites WHERE NOT utilizado AND revogado_em IS NULL",
    );
    const rev = await request("DELETE", `/convites/${id}`, undefined, professorToken);
    expect(rev.json().status).toBe("revogado");
    expect((await validar(segundo)).statusCode).toBe(410);
  });

  it("refuses expired invites", async () => {
    const c = (await convidar("atrasado@example.test")).json();
    // created_at é imutável pelo trigger: desliga só para simular o tempo passando.
    await db.query("ALTER TABLE convites DISABLE TRIGGER trg_convite_estado_final");
    await db.query(
      "UPDATE convites SET created_at = now() - interval '8 days', data_expiracao = now() - interval '1 day' WHERE id=$1",
      [c.id],
    );
    await db.query("ALTER TABLE convites ENABLE TRIGGER trg_convite_estado_final");
    const r = await validar(tokenDe(c.url));
    expect(r.statusCode).toBe(410);
    expect(r.json().error.code).toBe("CONVITE_EXPIRADO");
    expect((await enviar(tokenDe(c.url), ficha())).statusCode).toBe(410);
  });

  it("creates the student from the invite with health data and the minor lock, exactly once", async () => {
    const c = (await convidar("menor.convite@example.test")).json();
    const token = tokenDe(c.url);
    const menor = {
      pessoal: { data_nascimento: shift(todaySP(), -12), whatsapp: null },
    };
    // trava de menor: sem responsável não passa
    const sem = await enviar(token, ficha({ ...menor, treino: { data_matricula: todaySP() } }));
    expect(sem.statusCode).toBe(400);
    expect(JSON.stringify(sem.json().error.details)).toContain("responsavel");
    // vínculo a responsável existente não é aceito no fluxo público
    const comId = await enviar(
      token,
      ficha(
        { ...menor, treino: { data_matricula: todaySP() } },
        {
          responsavel: { id: randomUUID() },
        },
      ),
    );
    expect(comId.statusCode).toBe(400);
    // e-mail no corpo não é aceito: a conta usa o e-mail do convite
    const comEmail = ficha({}, {});
    (comEmail.acesso as Record<string, unknown>).email = "intruso@example.test";
    expect((await enviar(token, comEmail)).statusCode).toBe(400);

    const body = ficha(
      { ...menor, treino: { data_matricula: todaySP() } },
      {
        responsavel: guardian,
      },
    );
    const [a, b] = await Promise.all([enviar(token, body), enviar(token, body)]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes[0]).toBe(201); // um envio cria a conta…
    expect([409, 410]).toContain(codes[1]); // …o simultâneo é recusado
    const criado = (a.statusCode === 201 ? a : b).json();
    expect(criado.email).toBe("menor.convite@example.test");

    // conta funciona e a ficha veio completa
    const login = await request(
      "POST",
      "/auth/login",
      { email: "menor.convite@example.test", password: "senha-inicial-123" },
      "",
    );
    expect(login.statusCode).toBe(200);
    const f = (await request("GET", `/alunos/${criado.id}/ficha`)).json().ficha;
    expect(f).toMatchObject({
      menor_de_idade: true,
      responsavel: { nome: "Maria Responsável" },
      contato_principal: { origem: "responsavel" },
      saude: { tipo_sanguineo: "O+", condicoes_medicas: "Asma leve", atualizado_por: criado.id },
      termos_aceitos: true,
    });
    // convite consumido: não abre nem cadastra de novo
    expect((await validar(token)).json().error.code).toBe("CONVITE_UTILIZADO");
    const row = await one(db, "SELECT * FROM convites WHERE id=$1", [c.id]);
    expect(row).toMatchObject({ utilizado: true, aluno_id: criado.id });
    // estado final é imutável no banco e não pode ser revogado pela API
    await expect(
      db.query("UPDATE convites SET utilizado=false, utilizado_em=NULL WHERE id=$1", [c.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await request("DELETE", `/convites/${c.id}`, undefined, professorToken)).statusCode,
    ).toBe(409);
  });

  it("keeps the invite usable when the registration fails (rollback)", async () => {
    const token = tokenDe((await convidar("cpf.repetido@example.test")).json().url);
    const ocupado = cadastro();
    expect((await request("POST", "/alunos/cadastro", ocupado, professorToken)).statusCode).toBe(
      201,
    );
    const users = await count("users");
    const dup = await enviar(token, ficha({ pessoal: { cpf: ocupado.pessoal.cpf } }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("CPF_JA_CADASTRADO");
    expect(await count("users")).toBe(users);
    expect((await validar(token)).statusCode).toBe(200);
    expect((await enviar(token, ficha())).statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Perfil do aluno (0008): altura, peso e foto
// ---------------------------------------------------------------------------
describe("student self-service profile", () => {
  /** Bytes com a assinatura certa (o servidor confere a assinatura, não decodifica). */
  const webpFalso = (n: number) => {
    const b = Buffer.alloc(n, 7);
    b.write("RIFF", 0, "ascii");
    b.writeUInt32LE(n - 8, 4);
    b.write("WEBP", 8, "ascii");
    return b;
  };
  const webp = () => Buffer.from(imagemWebp);
  const jpeg = () => Buffer.from(imagemJpeg);
  const patch = (body: unknown, token = studentToken) =>
    request("PATCH", "/me/perfil", body, token);
  const upload = (b: Buffer, type: string, token = studentToken) =>
    request("PUT", "/me/foto", b, token, { "content-type": type });

  it("lets the student update height and weight with strict numeric input", async () => {
    const ok = await patch({ altura: "1,85", peso: 82.5 });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().perfil).toMatchObject({ altura: 1.85, peso: 82.5 });
    const quando = ok.json().perfil.medidas_atualizadas_em;
    expect(Date.now() - Date.parse(quando)).toBeLessThan(60_000);
    for (const body of [
      { peso: "82 quilos" },
      { altura: "1.85m" },
      { altura: "1,8,5" },
      { peso: "82.555" },
      { altura: 3 },
      { altura: 0.3 },
      { peso: 5 },
      { peso: 400 },
      {},
      { nome: "Outro Nome" },
      { foto_url: "https://evil.example/x.png" },
    ]) {
      const r = await patch(body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    // null apaga a medida
    const limpo = await patch({ peso: null });
    expect(limpo.json().perfil).toMatchObject({ altura: 1.85, peso: null });
    // só o aluno edita o próprio perfil por esta rota
    expect((await patch({ peso: 70 }, adminToken)).statusCode).toBe(403);
    expect((await patch({ peso: 70 }, "")).statusCode).toBe(401);
    // a equipe enxerga as medidas na ficha
    const visto = (await request("GET", `/alunos/${student}`)).json().perfil;
    expect(visto).toMatchObject({ altura: 1.85, peso: null });
  });

  it("stores medidas_atualizadas_em in the database and rejects out-of-range values there too", async () => {
    await db.query("UPDATE aluno_profile SET peso = 70 WHERE user_id = $1", [student]);
    const row = await one(db, "SELECT medidas_atualizadas_em FROM aluno_profile WHERE user_id=$1", [
      student,
    ]);
    expect(row.medidas_atualizadas_em).not.toBeNull();
    await expect(
      db.query("UPDATE aluno_profile SET altura = 2.9 WHERE user_id = $1", [student]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_altura" });
    await expect(
      db.query("UPDATE aluno_profile SET foto_url = 'javascript:alert(1)' WHERE user_id = $1", [
        student,
      ]),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_foto_url" });
  });

  it("uploads, serves, replaces and removes the profile photo", async () => {
    const first = await upload(webp(), "image/webp");
    expect(first.statusCode).toBe(200);
    const url1: string = first.json().foto_url;
    expect(url1).toMatch(/^\/api\/v1\/fotos\/[0-9a-f-]{36}$/);
    expect(
      (await request("GET", "/me/perfil", undefined, studentToken)).json().perfil.foto_url,
    ).toBe(url1);
    // servida sem login (para <img>), com tipo correto e cache imutável
    const img = await app.inject({ method: "GET", url: url1 });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect(img.headers["cache-control"]).toContain("immutable");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    expect((await sharp(img.rawPayload).metadata()).format).toBe("webp");
    // troca: novo link, o antigo deixa de existir, 1 foto por aluno
    const second = await upload(jpeg(), "image/jpeg");
    expect(second.statusCode).toBe(200);
    expect(second.json().foto_url).not.toBe(url1);
    expect((await app.inject({ method: "GET", url: url1 })).statusCode).toBe(404);
    expect(
      (await one(db, "SELECT count(*)::int AS n FROM fotos WHERE user_id=$1", [student])).n,
    ).toBe(1);
    // remoção
    expect((await request("DELETE", "/me/foto", undefined, studentToken)).statusCode).toBe(204);
    expect(
      (await request("GET", "/me/perfil", undefined, studentToken)).json().perfil.foto_url,
    ).toBe(null);
    expect((await app.inject({ method: "GET", url: second.json().foto_url })).statusCode).toBe(404);
  });

  it("rejects files that are not WebP/JPEG, mismatched types, oversized uploads and non-students", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(400)]);
    expect((await upload(png, "image/webp")).statusCode).toBe(400); // assinatura errada
    expect((await upload(jpeg(), "image/webp")).statusCode).toBe(400); // tipo ≠ conteúdo
    expect((await upload(webpFalso(400), "image/webp")).statusCode).toBe(400);
    expect((await upload(webpFalso(50), "image/webp")).statusCode).toBe(400); // pequeno demais
    expect((await upload(png, "image/png")).statusCode).toBe(415); // formato não aceito
    expect((await upload(webpFalso(600 * 1024), "image/webp")).statusCode).toBe(413); // > 512 KB
    expect((await upload(webp(), "image/webp", adminToken)).statusCode).toBe(403);
    expect((await upload(webp(), "image/webp", "")).statusCode).toBe(401);
    // o limite de 64 KB do JSON continua valendo nas outras rotas
    const big = await request("PATCH", "/me/perfil", { altura: "1.80", x: "a".repeat(70_000) });
    expect(big.statusCode).toBe(413);
    expect(await one(db, "SELECT count(*)::int AS n FROM fotos")).toEqual({ n: 0 });
    expect(
      (await app.inject({ method: "GET", url: `/api/v1/fotos/${randomUUID()}` })).statusCode,
    ).toBe(404);
  });
});

describe("PATCH /profile (spec alias) and foto_url ownership", () => {
  const jpeg = () => Buffer.from(imagemJpeg);
  const profile = (body: unknown, token = studentToken) =>
    request("PATCH", "/profile", body, token);

  it("keeps existing profiles valid with the new fields empty", async () => {
    const p = (await request("GET", "/me/perfil", undefined, studentToken)).json().perfil;
    expect(p).toMatchObject({
      foto_url: null,
      altura: null,
      peso: null,
      medidas_atualizadas_em: null,
    });
  });

  it("updates only foto_url, altura and peso, with numeric validation", async () => {
    const ok = await profile({ altura: 1.7, peso: "64,3" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().perfil).toMatchObject({ altura: 1.7, peso: 64.3 });
    for (const body of [
      { peso: "sessenta" },
      { altura: true },
      { nome: "X" },
      { modalidade: "boxe" },
    ])
      expect((await profile(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await profile({ peso: 70 }, adminToken)).statusCode).toBe(403);
  });

  it("accepts foto_url only as null or the student's own uploaded photo", async () => {
    const own = (
      await request("PUT", "/me/foto", jpeg(), studentToken, { "content-type": "image/jpeg" })
    ).json().foto_url as string;
    // link externo ou foto de outra pessoa: recusado
    for (const foto_url of ["https://tracker.example/p.gif", `/api/v1/fotos/${randomUUID()}`])
      expect((await profile({ foto_url })).statusCode, foto_url).toBe(400);
    // a própria foto atual: aceito (sem mudança)
    expect((await profile({ foto_url: own, peso: 71 })).json().perfil).toMatchObject({
      foto_url: own,
      peso: 71,
    });
    // null remove a foto e a imagem deixa de ser servida
    const removed = await profile({ foto_url: null });
    expect(removed.json().perfil.foto_url).toBeNull();
    expect((await app.inject({ method: "GET", url: own })).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Loja (0009): catálogo do aluno + pedido de intenção via WhatsApp
// ---------------------------------------------------------------------------
describe("store catalog and purchase intent", () => {
  const novoProduto = async (nome: string, extra: Record<string, unknown> = {}) =>
    (
      await request("POST", "/produtos", {
        nome,
        preco: "289.90",
        estoque_atual: 5,
        categoria: "Kimonos",
        ...extra,
      })
    ).json();
  const pedir = (produto_id: string, extra: Record<string, unknown> = {}, token = studentToken) =>
    request("POST", "/loja/pedido", { produto_id, ...extra }, token);
  const whats = (nome: string) =>
    `https://wa.me/5511999990000?text=${encodeURIComponent(`Olá, gostaria de adquirir o item ${nome}`)}`;

  it("lists only active products with the catalog fields, in-stock first", async () => {
    const kimono = await novoProduto("Kimono A1", { descricao: "Trançado leve.\nCor branca." });
    const esgotado = await novoProduto("Faixa Preta", { estoque_atual: 0, preco: "59.90" });
    const inativo = await novoProduto("Rashguard Antigo");
    await request("DELETE", `/produtos/${inativo.product_id}`);
    const lista = await request("GET", "/loja/produtos", undefined, studentToken);
    expect(lista.statusCode).toBe(200);
    // a tabela de produtos não é zerada entre testes: olha só os criados aqui
    const meus = (lista.json() as { id: string }[]).filter((x) =>
      [kimono.product_id, esgotado.product_id, inativo.product_id].includes(x.id),
    );
    expect(meus).toEqual([
      {
        id: kimono.product_id,
        nome: "Kimono A1",
        descricao: "Trançado leve.\nCor branca.",
        preco: "289.90",
        imagem_url: null,
        estoque: 5,
        categoria: "Kimonos",
      },
      expect.objectContaining({ id: esgotado.product_id, estoque: 0 }),
    ]);
    expect((await request("GET", "/loja/produtos", undefined, "")).statusCode).toBe(401);
  });

  it("registers the intent without touching stock or cash and returns the WhatsApp link", async () => {
    const p = await novoProduto("Kimono A2");
    const caixa = await count("cash_flow");
    const res = await pedir(p.product_id);
    expect(res.statusCode).toBe(201);
    expect(res.json().whatsapp_url).toBe(whats("Kimono A2"));
    expect(res.json().pedido).toMatchObject({
      user_id: student,
      product_id: p.product_id,
      quantidade: 1,
      preco_unitario: "289.90",
      status: "solicitado",
    });
    expect(
      (
        await one(db, "SELECT estoque_atual FROM inventory_product WHERE product_id=$1", [
          p.product_id,
        ])
      ).estoque_atual,
    ).toBe(5);
    expect(await count("cash_flow")).toBe(caixa);
    // clicar de novo reaproveita o pedido em aberto
    const de_novo = await pedir(p.product_id, { quantidade: 2 });
    expect(de_novo.statusCode).toBe(200);
    expect(de_novo.json().pedido.id).toBe(res.json().pedido.id);
    expect(decodeURIComponent(de_novo.json().whatsapp_url)).toContain("Kimono A2 (2 unidades)");
    expect(await count("pedidos_loja")).toBe(1);
  });

  it("limits purchase intent to ten requests per student per minute", async () => {
    const p = await novoProduto("Kimono rate limit");
    for (let i = 0; i < 10; i++) expect((await pedir(p.product_id)).statusCode).toBeLessThan(300);
    const blocked = await pedir(p.product_id);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("RATE_LIMITED");
  });

  it("allows cross-origin PUT preflight for product image upload", async () => {
    const preflight = await app.inject({
      method: "OPTIONS",
      url: `/api/v1/produtos/${randomUUID()}/imagem`,
      headers: {
        origin,
        "access-control-request-method": "PUT",
        "access-control-request-headers": "content-type,authorization",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-methods"]).toContain("PUT");
  });

  it("refuses sold-out, inactive, invalid and non-student requests", async () => {
    const zerado = await novoProduto("Luva 16oz", { estoque_atual: 0 });
    const r1 = await pedir(zerado.product_id);
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe("PRODUTO_ESGOTADO");
    const poucos = await novoProduto("Protetor bucal", { estoque_atual: 1 });
    expect((await pedir(poucos.product_id, { quantidade: 2 })).statusCode).toBe(409);
    const inativo = await novoProduto("Bermuda");
    await request("DELETE", `/produtos/${inativo.product_id}`);
    expect((await pedir(inativo.product_id)).statusCode).toBe(404);
    expect((await pedir("nao-e-uuid")).statusCode).toBe(400);
    expect((await pedir(poucos.product_id, { quantidade: 11 })).statusCode).toBe(400);
    expect((await pedir(poucos.product_id, {}, adminToken)).statusCode).toBe(403);
    // banco: só aluno pode ter pedido
    await expect(
      db.query("INSERT INTO pedidos_loja(user_id, product_id, preco_unitario) VALUES($1, $2, 1)", [
        admin,
        poucos.product_id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("answers 503 when the store WhatsApp is not configured, without registering anything", async () => {
    const semWhats = await buildApp({ ...config, WHATSAPP_LOJA: undefined }, db, {
      logger: false,
      stream: false,
    });
    try {
      const p = await novoProduto("Kimono A3");
      const r = await semWhats.inject({
        method: "POST",
        url: "/api/v1/loja/pedido",
        headers: { origin, authorization: `Bearer ${studentToken}` },
        payload: { produto_id: p.product_id },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("LOJA_SEM_WHATSAPP");
      expect(await count("pedidos_loja")).toBe(0);
    } finally {
      await semWhats.close();
    }
  });

  it("lets only the admin follow up on requests", async () => {
    const p = await novoProduto("Kimono A4");
    const { pedido } = (await pedir(p.product_id)).json();
    const lista = (await request("GET", "/loja/pedidos")).json();
    expect(lista.data[0]).toMatchObject({
      id: pedido.id,
      aluno_nome: "Pessoa Teste",
      produto_nome: "Kimono A4",
      status: "solicitado",
    });
    const ok = await request("PATCH", `/loja/pedidos/${pedido.id}`, { status: "atendido" });
    expect(ok.json()).toMatchObject({ status: "atendido", atendido_por: admin });
    const de_novo = await request("PATCH", `/loja/pedidos/${pedido.id}`, { status: "cancelado" });
    expect(de_novo.statusCode).toBe(409);
    expect(de_novo.json().error.code).toBe("PEDIDO_FINALIZADO");
    // depois de atendido, um novo pedido do mesmo produto é outro registro
    expect((await pedir(p.product_id)).statusCode).toBe(201);
    expect((await request("GET", "/loja/pedidos", undefined, studentToken)).statusCode).toBe(403);
    expect(
      (await request("PATCH", `/loja/pedidos/${pedido.id}`, { status: "atendido" }, studentToken))
        .statusCode,
    ).toBe(403);
  });

  it("rejects corrupted product images, keeps the current one and strips metadata (LOJA-03)", async () => {
    const p = await novoProduto("Kimono A6");
    const put = (dados: Buffer, tipo: string) =>
      request("PUT", `/produtos/${p.product_id}/imagem`, dados, adminToken, {
        "content-type": tipo,
      });
    const atual = (await put(Buffer.from(imagemWebp), "image/webp")).json().imagem_url as string;
    // assinatura RIFF/WEBP correta, conteúdo lixo (passava na checagem antiga de magic bytes)
    const assinaturaFalsa = Buffer.alloc(400, 7);
    assinaturaFalsa.write("RIFF", 0, "ascii");
    assinaturaFalsa.writeUInt32LE(392, 4);
    assinaturaFalsa.write("WEBP", 8, "ascii");
    const invalidos: [string, Buffer, string][] = [
      ["assinatura falsa", assinaturaFalsa, "image/webp"],
      [
        "WebP truncado",
        Buffer.from(imagemWebp).subarray(0, Math.floor(imagemWebp.length / 2)),
        "image/webp",
      ],
      ["JPEG declarado como WebP", Buffer.from(imagemJpeg), "image/webp"],
      [
        "bytes aleatórios",
        Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 131) % 256)),
        "image/jpeg",
      ],
    ];
    for (const [caso, dados, tipo] of invalidos) {
      const r = await put(dados, tipo);
      expect(r.statusCode, caso).toBe(400);
      expect(r.json().error.code, caso).toBe("VALIDATION_ERROR");
    }
    // nada foi trocado: a foto válida anterior continua sendo a vigente
    const row = await one(db, "SELECT imagem_url FROM inventory_product WHERE product_id=$1", [
      p.product_id,
    ]);
    expect(row.imagem_url).toBe(atual);
    expect(
      (
        await one(db, "SELECT count(*)::int AS n FROM produto_imagens WHERE product_id=$1", [
          p.product_id,
        ])
      ).n,
    ).toBe(1);
    expect((await app.inject({ method: "GET", url: atual })).statusCode).toBe(200);
    // EXIF (ex.: localização da câmera) não sobrevive à regravação no servidor
    const comExif = await sharp(Buffer.alloc(32 * 32 * 3, 90), {
      raw: { width: 32, height: 32, channels: 3 },
    })
      .withExif({ IFD0: { Copyright: "SEGREDO-GPS-AUDITORIA" } })
      .jpeg()
      .toBuffer();
    expect(comExif.includes("SEGREDO-GPS-AUDITORIA")).toBe(true);
    const nova = (await put(comExif, "image/jpeg")).json().imagem_url as string;
    const servida = (await app.inject({ method: "GET", url: nova })).rawPayload;
    expect(servida.includes("SEGREDO-GPS-AUDITORIA")).toBe(false);
    expect((await sharp(servida).metadata()).exif).toBeUndefined();
  });

  it("refuses external photo URLs for the profile too, even by direct SQL (LOJA-02)", async () => {
    await expect(
      db.query(
        "UPDATE aluno_profile SET foto_url='https://tracker.example/p.gif' WHERE user_id=$1",
        [student],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_aluno_foto_url" });
  });

  it("stores the product photo and description managed by the admin", async () => {
    const p = await novoProduto("Kimono A5");
    const webp = Buffer.from(imagemWebp);
    const up = await request("PUT", `/produtos/${p.product_id}/imagem`, webp, adminToken, {
      "content-type": "image/webp",
    });
    expect(up.statusCode).toBe(200);
    const url: string = up.json().imagem_url;
    expect(url).toMatch(/^\/api\/v1\/loja\/imagens\/[0-9a-f-]{36}$/);
    const img = await app.inject({ method: "GET", url });
    expect(img.statusCode).toBe(200);
    expect(img.headers["content-type"]).toBe("image/webp");
    expect((await sharp(img.rawPayload).metadata()).format).toBe("webp");
    expect(
      (await request("GET", "/loja/produtos", undefined, studentToken))
        .json()
        .find((x: { id: string }) => x.id === p.product_id).imagem_url,
    ).toBe(url);
    expect(
      (
        await request("PUT", `/produtos/${p.product_id}/imagem`, webp, studentToken, {
          "content-type": "image/webp",
        })
      ).statusCode,
    ).toBe(403);
    // descrição: define e apaga
    const d = await request("PATCH", `/produtos/${p.product_id}`, { descricao: "Novo texto" });
    expect(d.json().descricao).toBe("Novo texto");
    const d2 = await request("PATCH", `/produtos/${p.product_id}`, { descricao: null });
    expect(d2.json()).toMatchObject({ descricao: null, nome: "Kimono A5" });
    // remover foto
    expect(
      (await request("DELETE", `/produtos/${p.product_id}/imagem`)).json().imagem_url,
    ).toBeNull();
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    await expect(
      db.query(
        "UPDATE inventory_product SET imagem_url='https://tracker.example/pixel.gif' WHERE product_id=$1",
        [p.product_id],
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "ck_product_imagem_url" });
  });
});

// ---------------------------------------------------------------------------
// Painel de gestão ativa: GET /financeiro/mensalidades
// PAGO = entrada 'mensalidade' no cash_flow ligada a cobrança com vencimento no
// mês atual (America/Sao_Paulo); caso contrário PENDENTE.
// ---------------------------------------------------------------------------
describe("active billing panel (GET /financeiro/mensalidades)", () => {
  let professorToken: string;
  const ids: Record<string, string> = {};
  /** Cobrança com vencimento relativo ao 1º dia do mês atual. */
  const cobranca = async (id: string, diasDoInicioDoMes: number) =>
    (
      await one(
        db,
        `INSERT INTO financeiro(user_id, valor, data_vencimento)
         VALUES ($1, '150.00', date_trunc('month', fn_hoje_sp())::date + $2::int) RETURNING payment_id`,
        [id, diasDoInicioDoMes],
      )
    ).payment_id as string;
  const pagar = (payment_id: string) =>
    request("PATCH", `/mensalidades/${payment_id}/pagar`, { metodo_pagamento: "pix" });
  const painel = (query = "", token = adminToken) =>
    request("GET", `/financeiro/mensalidades${query}`, undefined, token);
  const doPainel = (body: { data: { user_id: string }[] }) =>
    Object.fromEntries(
      body.data.filter((i) => Object.values(ids).includes(i.user_id)).map((i) => [i.user_id, i]),
    ) as Record<string, Record<string, unknown>>;

  beforeEach(async () => {
    await user("prof.painel@example.test", "professor");
    professorToken = (
      await request("POST", "/auth/login", { email: "prof.painel@example.test", password }, "")
    ).json().access_token;
    for (const k of [
      "pagou",
      "devendo",
      "semCobranca",
      "pagouMesPassado",
      "pagoSemCaixa",
      "inativo",
    ])
      ids[k] = await user(`${k.toLowerCase()}@painel.test`);
    // 1. pagou a mensalidade deste mês → cash_flow 'mensalidade'
    expect((await pagar(await cobranca(ids.pagou, 9))).statusCode).toBe(200);
    // 2. cobrança deste mês em aberto
    await cobranca(ids.devendo, 9);
    // 3. sem cobrança gerada neste mês (fica 'pendente' com vencimento previsto)
    // 4. quitou HOJE a mensalidade do mês PASSADO: não vale para o mês atual
    expect((await pagar(await cobranca(ids.pagouMesPassado, -20))).statusCode).toBe(200);
    await cobranca(ids.pagouMesPassado, 9);
    // 5. cobrança marcada 'pago' sem lançamento no caixa: a regra é o cash_flow
    const sem = await cobranca(ids.pagoSemCaixa, 9);
    await db.query(
      "UPDATE financeiro SET status='pago', data_pagamento=fn_hoje_sp(), metodo_pagamento='pix' WHERE payment_id=$1",
      [sem],
    );
    // 6. aluno inativo não aparece, mesmo pago
    await pagar(await cobranca(ids.inativo, 9));
    await db.query("UPDATE users SET status='inativo' WHERE id=$1", [ids.inativo]);
  });

  it("computes PAGO only from a cash_flow entry for the current month's bill", async () => {
    const res = await painel("?page_size=100");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.competencia).toBe(todaySP().slice(0, 7));
    const p = doPainel(body);
    expect(p[ids.pagou]).toMatchObject({ status: "pago", cobranca_gerada: true });
    expect(p[ids.pagou].pago_em).not.toBeNull();
    expect(p[ids.devendo]).toMatchObject({
      status: "pendente",
      cobranca_gerada: true,
      pago_em: null,
    });
    expect(p[ids.semCobranca]).toMatchObject({
      status: "pendente",
      cobranca_gerada: false,
      payment_id: null,
      // sem cobrança: vencimento previsto pelo dia padrão (BILLING_DUE_DAY = 10)
      data_vencimento: `${todaySP().slice(0, 7)}-10`,
    });
    expect(p[ids.pagouMesPassado]).toMatchObject({ status: "pendente" });
    expect(p[ids.pagoSemCaixa]).toMatchObject({ status: "pendente" });
    expect(p[ids.inativo]).toBeUndefined();
    expect(p[ids.devendo].data_vencimento).toBe(shift(`${todaySP().slice(0, 7)}-01`, 0, 9));
    // valores: o gestor recebe o valor da cobrança do mês (para a baixa rápida)...
    expect(p[ids.devendo].valor).toBe("150.00");
    expect(p[ids.semCobranca].valor).toBeNull();
    // ...o professor não recebe nenhum valor
    const prof = await painel("?page_size=100", professorToken);
    expect(prof.statusCode).toBe(200);
    expect(prof.body).not.toContain("150.00");
    expect(doPainel(prof.json())[ids.devendo]).not.toHaveProperty("valor");
    // contadores das abas batem com a lista
    expect(body.resumo.todos).toBe(body.total);
    expect(body.resumo.pago + body.resumo.pendente).toBe(body.resumo.todos);
  });

  it("filters on the server by ?status (case-insensitive) and keeps tab counts", async () => {
    const pendentes = (await painel("?status=pendente&page_size=100")).json();
    expect(pendentes.data.every((i: { status: string }) => i.status === "pendente")).toBe(true);
    expect(Object.keys(doPainel(pendentes)).sort()).toEqual(
      [ids.devendo, ids.semCobranca, ids.pagouMesPassado, ids.pagoSemCaixa].sort(),
    );
    const pagos = (await painel("?status=PAGO&page_size=100")).json();
    expect(Object.keys(doPainel(pagos))).toEqual([ids.pagou]);
    expect(pagos.total).toBe(pagos.resumo.pago);
    expect(pendentes.total).toBe(pendentes.resumo.pendente);
    // busca por nome combina com o filtro
    expect((await painel("?status=pendente&q=nenhum-aluno-assim")).json().total).toBe(0);
    for (const q of ["?status=atrasado", "?status=", "?extra=1"])
      expect((await painel(q)).statusCode, q).toBe(400);
  });

  it("is available to admin and professor only", async () => {
    expect((await painel("", adminToken)).statusCode).toBe(200);
    expect((await painel("", professorToken)).statusCode).toBe(200);
    expect((await painel("", studentToken)).statusCode).toBe(403);
    expect((await painel("", "")).statusCode).toBe(401);
    // o restante do financeiro continua só do gestor
    expect((await request("GET", "/mensalidades", undefined, professorToken)).statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Baixa rápida: POST /financeiro/baixa (só gestor)
// Uma transação: entrada 'mensalidade' no cash_flow + cobrança marcada como paga.
// ---------------------------------------------------------------------------
describe("quick payment (POST /financeiro/baixa)", () => {
  let professorToken: string;
  let aluno: string;
  let cobranca: string;
  const baixa = (body: Record<string, unknown>, token = adminToken) =>
    request("POST", "/financeiro/baixa", body, token);
  const estado = async (payment_id: string) => ({
    financeiro: await one(
      db,
      "SELECT status, valor, data_pagamento::text, metodo_pagamento FROM financeiro WHERE payment_id=$1",
      [payment_id],
    ),
    caixa: (
      await db.query(
        "SELECT tipo, categoria, valor, motivo, registrado_por FROM cash_flow WHERE payment_id=$1",
        [payment_id],
      )
    ).rows,
  });

  beforeEach(async () => {
    await user("prof.baixa@example.test", "professor");
    professorToken = (
      await request("POST", "/auth/login", { email: "prof.baixa@example.test", password }, "")
    ).json().access_token;
    aluno = await user("aluno.baixa@example.test");
    cobranca = (
      await one(
        db,
        `INSERT INTO financeiro(user_id, valor, data_vencimento)
         VALUES ($1, '150.00', date_trunc('month', fn_hoje_sp())::date + 9) RETURNING payment_id`,
        [aluno],
      )
    ).payment_id;
  });

  it("records the cash entry AND marks the bill as paid in one step", async () => {
    const res = await baixa({ payment_id: cobranca, valor_pago: "150.00" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.mensalidade).toMatchObject({ payment_id: cobranca, status: "pago" });
    expect(body.lancamento).toMatchObject({
      payment_id: cobranca,
      tipo: "entrada",
      categoria: "mensalidade",
      valor: "150.00",
    });
    const e = await estado(cobranca);
    expect(e.financeiro).toMatchObject({
      status: "pago",
      valor: "150.00",
      data_pagamento: todaySP(),
      metodo_pagamento: "pix", // padrão quando não informado
    });
    expect(e.caixa).toEqual([
      {
        tipo: "entrada",
        categoria: "mensalidade",
        valor: "150.00",
        motivo: `Mensalidade ${cobranca}`,
        registrado_por: admin,
      },
    ]);
    // o painel passa a mostrar o aluno como pago
    const painel = (await request("GET", "/financeiro/mensalidades?status=pago")).json();
    expect(painel.data.map((i: { user_id: string }) => i.user_id)).toContain(aluno);
  });

  it("stores the amount actually received and reports it as received", async () => {
    const competencia = todaySP().slice(0, 7);
    const antes = (await request("GET", `/financeiro/resumo?competencia=${competencia}`)).json();
    const res = await baixa({
      payment_id: cobranca,
      valor_pago: "120.00",
      metodo_pagamento: "dinheiro",
    });
    expect(res.statusCode).toBe(201);
    const e = await estado(cobranca);
    // a cobrança guarda o valor cobrado; o caixa, o valor recebido
    expect(e.financeiro).toMatchObject({ valor: "150.00", metodo_pagamento: "dinheiro" });
    expect(e.caixa).toHaveLength(1);
    expect(e.caixa[0]).toMatchObject({
      valor: "120.00",
      motivo: `Mensalidade ${cobranca} (cobrado 150.00)`,
    });
    const depois = (await request("GET", `/financeiro/resumo?competencia=${competencia}`)).json();
    expect(Number(depois.recebido) - Number(antes.recebido)).toBeCloseTo(120, 2);
    expect(depois.previsto).toBe(antes.previsto);
  });

  it("forbids professors (403), students (403) and anonymous users (401), writing nothing", async () => {
    expect(
      (await baixa({ payment_id: cobranca, valor_pago: "150.00" }, professorToken)).statusCode,
    ).toBe(403);
    expect(
      (await baixa({ payment_id: cobranca, valor_pago: "150.00" }, studentToken)).statusCode,
    ).toBe(403);
    expect((await baixa({ payment_id: cobranca, valor_pago: "150.00" }, "")).statusCode).toBe(401);
    const e = await estado(cobranca);
    expect(e.financeiro.status).toBe("pendente");
    expect(e.caixa).toHaveLength(0);
  });

  it("refuses a bill that is already paid (409) without a second cash entry", async () => {
    expect((await baixa({ payment_id: cobranca, valor_pago: "150.00" })).statusCode).toBe(201);
    const repetida = await baixa({ payment_id: cobranca, valor_pago: "150.00" });
    expect(repetida.statusCode).toBe(409);
    expect(repetida.json().error.code).toBe("MENSALIDADE_JA_PAGA");
    // paga pela rota antiga também conta
    const outra = (
      await one(
        db,
        "INSERT INTO financeiro(user_id, valor, data_vencimento) VALUES ($1, '150.00', fn_hoje_sp() + 40) RETURNING payment_id",
        [aluno],
      )
    ).payment_id;
    expect(
      (await request("PATCH", `/mensalidades/${outra}/pagar`, { metodo_pagamento: "pix" }))
        .statusCode,
    ).toBe(200);
    expect((await baixa({ payment_id: outra, valor_pago: "150.00" })).statusCode).toBe(409);
    expect((await estado(cobranca)).caixa).toHaveLength(1);
    expect((await estado(outra)).caixa).toHaveLength(1);
  });

  it("lets only one of two simultaneous clicks through", async () => {
    const [a, b] = await Promise.all([
      baixa({ payment_id: cobranca, valor_pago: "150.00" }),
      baixa({ payment_id: cobranca, valor_pago: "150.00" }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((await estado(cobranca)).caixa).toHaveLength(1);
  });

  it("rolls back the bill update when the cash entry fails (atomicity)", async () => {
    await db.query(`CREATE FUNCTION falha_caixa() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'falha simulada no caixa'; END $$`);
    await db.query(
      "CREATE TRIGGER tg_falha_caixa BEFORE INSERT ON cash_flow FOR EACH ROW EXECUTE FUNCTION falha_caixa()",
    );
    try {
      expect((await baixa({ payment_id: cobranca, valor_pago: "150.00" })).statusCode).toBe(500);
    } finally {
      await db.query("DROP TRIGGER tg_falha_caixa ON cash_flow");
      await db.query("DROP FUNCTION falha_caixa()");
    }
    const e = await estado(cobranca);
    expect(e.financeiro).toMatchObject({
      status: "pendente",
      data_pagamento: null,
      metodo_pagamento: null,
    });
    expect(e.caixa).toHaveLength(0);
    // sem a falha, a mesma baixa passa
    expect((await baixa({ payment_id: cobranca, valor_pago: "150.00" })).statusCode).toBe(201);
  });

  it("validates the payload", async () => {
    for (const body of [
      {},
      { payment_id: cobranca },
      { payment_id: cobranca, valor_pago: "0.00" },
      { payment_id: cobranca, valor_pago: "150" },
      { payment_id: cobranca, valor_pago: 150 },
      { payment_id: cobranca, valor_pago: "-1.00" },
      { payment_id: "nao-e-uuid", valor_pago: "150.00" },
      { payment_id: cobranca, valor_pago: "150.00", metodo_pagamento: "cheque" },
      { payment_id: cobranca, valor_pago: "150.00", extra: 1 },
    ])
      expect((await baixa(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await baixa({ payment_id: randomUUID(), valor_pago: "150.00" })).statusCode).toBe(404);
    expect((await estado(cobranca)).caixa).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Cobrança por WhatsApp: POST /notificacoes/cobrar (só gestor)
// Menor de idade → responsável; maior → o próprio aluno. Devolve mensagem + wa.me.
// ---------------------------------------------------------------------------
describe("billing reminders via WhatsApp (POST /notificacoes/cobrar)", () => {
  const PIX = "financeiro@academia.test";
  const cobrar = (body: Record<string, unknown>, token = adminToken) =>
    request("POST", "/notificacoes/cobrar", body, token);
  /** Oráculo independente da API: competência por extenso via ICU do Node. */
  const porExtenso = (competencia: string) =>
    new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(`${competencia}-15T12:00:00Z`),
    );
  const competencia = () => todaySP().slice(0, 7);
  async function aluno(o: {
    nome: string;
    email: string;
    nascimento?: string;
    whatsapp?: string | null;
    responsavel?: { nome: string; whatsapp: string };
  }) {
    const id = await user(o.email);
    let responsavel: string | null = null;
    if (o.responsavel)
      responsavel = (
        await one(
          db,
          `INSERT INTO responsaveis(nome, parentesco, whatsapp, telefone_emergencia)
           VALUES ($1, 'pai', $2, '5511900009999') RETURNING id`,
          [o.responsavel.nome, o.responsavel.whatsapp],
        )
      ).id;
    await db.query("UPDATE users SET nome=$2 WHERE id=$1", [id, o.nome]);
    await db.query(
      "UPDATE aluno_profile SET data_nascimento=$2, whatsapp=$3, responsavel_id=$4 WHERE user_id=$1",
      [id, o.nascimento ?? null, o.whatsapp ?? null, responsavel],
    );
    return id;
  }
  const cobranca = async (user_id: string, valor = "180.00") =>
    (
      await one(
        db,
        `INSERT INTO financeiro(user_id, valor, data_vencimento)
         VALUES ($1, $2, date_trunc('month', fn_hoje_sp())::date + 9) RETURNING payment_id`,
        [user_id, valor],
      )
    ).payment_id as string;

  it("sends adults' reminders to the student, with the exact message and wa.me link", async () => {
    const id = await aluno({
      nome: "Ana Adulta Souza",
      email: "ana.adulta@cobrar.test",
      nascimento: "1990-05-01",
      whatsapp: "5511911110000",
    });
    const payment_id = await cobranca(id);
    const res = await cobrar({ payment_id });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const mensagem =
      `Olá, Ana! Notamos que a mensalidade de Ana Adulta Souza referente a ${porExtenso(competencia())} ` +
      `ainda está pendente. Valor: R$ 180,00. Segue a chave Pix: ${PIX}`;
    expect(body).toMatchObject({
      payment_id,
      user_id: id,
      aluno_nome: "Ana Adulta Souza",
      menor_de_idade: false,
      competencia: competencia(),
      valor: "180.00",
      destinatario: { tipo: "aluno", nome: "Ana Adulta Souza", whatsapp: "5511911110000" },
      mensagem,
    });
    expect(body.whatsapp_url).toBe(
      `https://wa.me/5511911110000?text=${encodeURIComponent(mensagem)}`,
    );
    const link = new URL(body.whatsapp_url);
    expect([link.protocol, link.hostname, link.pathname]).toEqual([
      "https:",
      "wa.me",
      "/5511911110000",
    ]);
    expect(link.searchParams.get("text")).toBe(mensagem);
    // só gera o link: a cobrança continua pendente e nada entra no caixa
    expect(
      (await one(db, "SELECT status FROM financeiro WHERE payment_id=$1", [payment_id])).status,
    ).toBe("pendente");
    expect(
      (await db.query("SELECT 1 FROM cash_flow WHERE payment_id=$1", [payment_id])).rowCount,
    ).toBe(0);
  });

  it("sends minors' reminders to the guardian even when the minor has a WhatsApp", async () => {
    const id = await aluno({
      nome: "Lucas Menor Lima",
      email: "lucas.menor@cobrar.test",
      nascimento: shift(todaySP(), -10),
      whatsapp: "5511933330000", // o próprio menor tem número: NÃO deve ser usado
      responsavel: { nome: "Marcos Lima", whatsapp: "5511922220000" },
    });
    const payment_id = await cobranca(id, "1234.50");
    const body = (await cobrar({ payment_id })).json();
    expect(body.menor_de_idade).toBe(true);
    expect(body.destinatario).toEqual({
      tipo: "responsavel",
      nome: "Marcos Lima",
      whatsapp: "5511922220000",
    });
    expect(body.mensagem).toBe(
      `Olá, Marcos! Notamos que a mensalidade de Lucas Menor Lima referente a ${porExtenso(competencia())} ` +
        `ainda está pendente. Valor: R$ 1.234,50. Segue a chave Pix: ${PIX}`,
    );
    expect(new URL(body.whatsapp_url).pathname).toBe("/5511922220000");
    expect(body.whatsapp_url).not.toContain("5511933330000");
  });

  it("uses the 18th birthday in America/Sao_Paulo as the adult boundary", async () => {
    const responsavel = { nome: "Rita Borda", whatsapp: "5511944440000" };
    const faz18Hoje = await aluno({
      nome: "Bia Dezoito",
      email: "bia.18@cobrar.test",
      nascimento: shift(todaySP(), -18),
      whatsapp: "5511955550000",
      responsavel,
    });
    const faz18Amanha = await aluno({
      nome: "Caio Quase",
      email: "caio.17@cobrar.test",
      nascimento: shift(todaySP(), -18, 1),
      whatsapp: "5511966660000",
      responsavel: { ...responsavel, whatsapp: "5511977770000" },
    });
    const adulto = (await cobrar({ payment_id: await cobranca(faz18Hoje) })).json();
    expect(adulto).toMatchObject({
      menor_de_idade: false,
      destinatario: { tipo: "aluno", whatsapp: "5511955550000" },
    });
    const menor = (await cobrar({ payment_id: await cobranca(faz18Amanha) })).json();
    expect(menor).toMatchObject({
      menor_de_idade: true,
      destinatario: { tipo: "responsavel", whatsapp: "5511977770000" },
    });
  });

  it("falls back to the guardian for adults without WhatsApp and refuses when there is no number", async () => {
    const comResp = await aluno({
      nome: "Davi Sem Numero",
      email: "davi@cobrar.test",
      nascimento: "1995-01-01",
      responsavel: { nome: "Helena Costa", whatsapp: "5511988880000" },
    });
    expect((await cobrar({ payment_id: await cobranca(comResp) })).json().destinatario).toEqual({
      tipo: "responsavel",
      nome: "Helena Costa",
      whatsapp: "5511988880000",
    });
    // cadastro antigo: sem nascimento, sem WhatsApp, sem responsável
    const semNada = await aluno({ nome: "Eva Antiga", email: "eva@cobrar.test" });
    const res = await cobrar({ payment_id: await cobranca(semNada) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: "SEM_WHATSAPP" });
    expect(res.json().error.message).toContain("Eva Antiga");
  });

  it("is admin-only, refuses paid or unknown bills and validates the payload", async () => {
    const id = await aluno({
      nome: "Fabio Rbac",
      email: "fabio@cobrar.test",
      nascimento: "1990-01-01",
      whatsapp: "5511912340000",
    });
    const payment_id = await cobranca(id);
    await user("prof.cobrar@example.test", "professor");
    const professorToken = (
      await request("POST", "/auth/login", { email: "prof.cobrar@example.test", password }, "")
    ).json().access_token;
    expect((await cobrar({ payment_id }, professorToken)).statusCode).toBe(403);
    expect((await cobrar({ payment_id }, studentToken)).statusCode).toBe(403);
    expect((await cobrar({ payment_id }, "")).statusCode).toBe(401);
    for (const body of [{}, { payment_id: "x" }, { payment_id, extra: 1 }])
      expect((await cobrar(body)).statusCode, JSON.stringify(body)).toBe(400);
    expect((await cobrar({ payment_id: randomUUID() })).statusCode).toBe(404);
    // depois da baixa não se cobra mais
    expect(
      (await request("POST", "/financeiro/baixa", { payment_id, valor_pago: "180.00" })).statusCode,
    ).toBe(201);
    const paga = await cobrar({ payment_id });
    expect(paga.statusCode).toBe(409);
    expect(paga.json().error.code).toBe("MENSALIDADE_JA_PAGA");
  });

  it("answers 503 when the academy Pix key is not configured", async () => {
    const semPix = await buildApp({ ...config, PIX_CHAVE: undefined }, db, {
      logger: false,
      stream: false,
    });
    try {
      const id = await aluno({
        nome: "Gil Sem Pix",
        email: "gil@cobrar.test",
        nascimento: "1990-01-01",
        whatsapp: "5511912349999",
      });
      const r = await semPix.inject({
        method: "POST",
        url: "/api/v1/notificacoes/cobrar",
        headers: { origin, authorization: `Bearer ${adminToken}` },
        payload: { payment_id: await cobranca(id) },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe("PIX_NAO_CONFIGURADO");
    } finally {
      await semPix.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Área do aluno espelha o painel do gestor: GET /me/mensalidades/atual usa a
// mesma consulta do GET /financeiro/mensalidades; o histórico segue a regra
// do caixa (pago só com entrada 'mensalidade' no cash_flow).
// ---------------------------------------------------------------------------
describe("student billing mirrors the admin panel", () => {
  const CAMPOS = [
    "user_id",
    "payment_id",
    "data_vencimento",
    "cobranca_gerada",
    "pago_em",
    "status",
    "valor",
  ] as const;
  const doAdmin = async (user_id: string) => {
    const body = (await request("GET", "/financeiro/mensalidades?page_size=100")).json();
    return body.data.find((i: { user_id: string }) => i.user_id === user_id);
  };
  const doAluno = async () => {
    const res = await request("GET", "/me/mensalidades/atual", undefined, studentToken);
    expect(res.statusCode).toBe(200);
    return res.json();
  };
  const pick = (o: Record<string, unknown>) => Object.fromEntries(CAMPOS.map((k) => [k, o[k]]));
  const historico = async (query = "") =>
    (await request("GET", `/me/mensalidades${query}`, undefined, studentToken)).json();
  const cobrancaDoMes = async () =>
    (
      await request("POST", "/mensalidades", {
        user_id: student,
        valor: "150.00",
        data_vencimento: `${todaySP().slice(0, 7)}-10`,
      })
    ).json().payment_id as string;

  it("shows PENDENTE to the student when the month has no bill yet, exactly like the admin", async () => {
    const aluno = await doAluno();
    expect(aluno).toMatchObject({
      competencia: todaySP().slice(0, 7),
      status: "pendente",
      cobranca_gerada: false,
      payment_id: null,
      valor: null,
      data_vencimento: `${todaySP().slice(0, 7)}-10`,
    });
    expect(pick(aluno)).toEqual(pick(await doAdmin(student)));
    // sem cobrança lançada o histórico continua vazio (o "mês atual" é que mostra a pendência)
    expect(await historico()).toEqual([]);
  });

  it("stays in sync through bill creation and quick payment", async () => {
    const payment_id = await cobrancaDoMes();
    let aluno = await doAluno();
    expect(aluno).toMatchObject({
      status: "pendente",
      cobranca_gerada: true,
      payment_id,
      valor: "150.00",
    });
    expect(pick(aluno)).toEqual(pick(await doAdmin(student)));

    expect(
      (await request("POST", "/financeiro/baixa", { payment_id, valor_pago: "150.00" })).statusCode,
    ).toBe(201);
    aluno = await doAluno();
    expect(aluno.status).toBe("pago");
    expect(aluno.pago_em).not.toBeNull();
    expect(pick(aluno)).toEqual(pick(await doAdmin(student)));
    const [linha] = await historico();
    expect(linha).toMatchObject({ payment_id, status: "pago", data_pagamento: todaySP() });
  });

  it("does not show PAGO to the student without the cash entry (same rule as the admin)", async () => {
    const payment_id = await cobrancaDoMes();
    // marcada 'pago' direto no banco, sem lançamento no caixa
    await db.query(
      "UPDATE financeiro SET status='pago', data_pagamento=fn_hoje_sp(), metodo_pagamento='pix' WHERE payment_id=$1",
      [payment_id],
    );
    expect((await doAdmin(student)).status).toBe("pendente");
    expect((await doAluno()).status).toBe("pendente");
    const [linha] = await historico();
    expect(linha.status).not.toBe("pago");
    expect(linha).toMatchObject({ data_pagamento: null, metodo_pagamento: null });
    expect(await historico("?status=pago")).toEqual([]);
    expect(
      (await historico(`?status=${linha.status}`)).map((l: { payment_id: string }) => l.payment_id),
    ).toEqual([payment_id]);
  });

  it("keeps the route student-only and the default amount admin-only", async () => {
    expect((await request("GET", "/me/mensalidades/atual")).statusCode).toBe(403);
    expect((await request("GET", "/me/mensalidades/atual", undefined, "")).statusCode).toBe(401);
    expect((await request("GET", "/financeiro/mensalidades")).json().valor_padrao).toBe("150.00");
    await user("prof.espelho@example.test", "professor");
    const professorToken = (
      await request("POST", "/auth/login", { email: "prof.espelho@example.test", password }, "")
    ).json().access_token;
    const prof = await request("GET", "/financeiro/mensalidades", undefined, professorToken);
    expect(prof.statusCode).toBe(200);
    expect(prof.json()).not.toHaveProperty("valor_padrao");
  });
});

// ---------------------------------------------------------------------------
// Turmas (0010) e chamada por turma
// ---------------------------------------------------------------------------
describe("classes and roll call (turmas / chamada)", () => {
  let professor: string;
  let professorToken: string;
  const alunos: Record<string, string> = {};
  const novaTurma = (body: Record<string, unknown>, token = adminToken) =>
    request("POST", "/turmas", body, token);
  const chamada = (id: string, presentes: string[], token = adminToken) =>
    request("POST", `/turmas/${id}/chamada`, { presentes }, token);
  const presencas = async (user_id: string) =>
    (await one(db, "SELECT total_presencas FROM aluno_profile WHERE user_id=$1", [user_id]))
      .total_presencas as number;
  const registros = async (user_id: string) =>
    (
      await db.query("SELECT turma_id FROM attendance WHERE user_id=$1 ORDER BY check_in", [
        user_id,
      ])
    ).rows.map((r) => r.turma_id as string | null);

  beforeEach(async () => {
    professor = await user("prof.turma@example.test", "professor");
    professorToken = (
      await request("POST", "/auth/login", { email: "prof.turma@example.test", password }, "")
    ).json().access_token;
    for (const k of ["ana", "bia", "caio", "fora"]) alunos[k] = await user(`${k}@turma.test`);
  });

  it("creates a class with members, lists it and filters students by class", async () => {
    const res = await novaTurma({
      nome: "Iniciantes Manhã",
      horario: "Seg, Qua e Sex · 7h",
      modalidade: "jiu_jitsu",
      professor_id: professor,
      alunos: [alunos.ana, alunos.bia],
    });
    expect(res.statusCode).toBe(201);
    const turma = res.json();
    expect(turma).toMatchObject({
      nome: "Iniciantes Manhã",
      horario: "Seg, Qua e Sex · 7h",
      modalidade: "jiu_jitsu",
      professor_id: professor,
      ativa: true,
      total_alunos: 2,
    });
    const lista = (await request("GET", "/turmas", undefined, professorToken)).json();
    expect(lista.map((t: { id: string }) => t.id)).toContain(turma.id);
    const detalhe = (await request("GET", `/turmas/${turma.id}`)).json();
    expect(detalhe.alunos.map((a: { user_id: string }) => a.user_id).sort()).toEqual(
      [alunos.ana, alunos.bia].sort(),
    );
    // GET /alunos?turma_id= traz só quem é da turma
    const filtrados = (await request("GET", `/alunos?turma_id=${turma.id}&page_size=100`)).json();
    expect(filtrados.data.map((a: { id: string }) => a.id).sort()).toEqual(
      [alunos.ana, alunos.bia].sort(),
    );
    // nome repetido entre turmas ativas (sem diferenciar maiúsculas/espaços)
    const repetida = await novaTurma({ nome: "  iniciantes manhã " });
    expect(repetida.statusCode).toBe(409);
    expect(repetida.json().error.code).toBe("TURMA_JA_EXISTE");
    // professor precisa ser da equipe; membro precisa ser aluno
    expect((await novaTurma({ nome: "Turma X", professor_id: alunos.ana })).json().error.code).toBe(
      "PROFESSOR_INVALIDO",
    );
    const naoAluno = await novaTurma({ nome: "Turma Y", alunos: [professor] });
    expect(naoAluno.statusCode).toBe(400);
    expect(naoAluno.json().error.code).toBe("ALUNO_INVALIDO");
    expect((await request("GET", "/turmas")).json()).toHaveLength(1); // nada criado nas falhas
  });

  it("edits the class and the change shows up on the roll call", async () => {
    const turma = (
      await novaTurma({ nome: "Jiu-Jitsu 19h", horario: "Ter e Qui · 19h", alunos: [alunos.ana] })
    ).json();
    const editada = await request("PATCH", `/turmas/${turma.id}`, {
      nome: "Jiu-Jitsu 20h",
      horario: "Ter e Qui · 20h",
      professor_id: professor,
    });
    expect(editada.statusCode).toBe(200);
    expect(editada.json()).toMatchObject({
      nome: "Jiu-Jitsu 20h",
      horario: "Ter e Qui · 20h",
      professor_id: professor,
    });
    const lista = (
      await request("GET", `/turmas/${turma.id}/chamada`, undefined, professorToken)
    ).json();
    expect(lista.turma).toMatchObject({ nome: "Jiu-Jitsu 20h", horario: "Ter e Qui · 20h" });
    expect(lista.data).toBe(todaySP());
    // null limpa o horário; campo ausente não mexe
    expect((await request("PATCH", `/turmas/${turma.id}`, { horario: null })).json()).toMatchObject(
      {
        nome: "Jiu-Jitsu 20h",
        horario: null,
      },
    );
    expect((await request("PATCH", `/turmas/${turma.id}`, {})).statusCode).toBe(400);
    // desativada: some da lista e não aceita chamada
    await request("PATCH", `/turmas/${turma.id}`, { ativa: false });
    expect((await request("GET", "/turmas")).json()).toHaveLength(0);
    expect((await request("GET", "/turmas?incluir_inativas=true")).json()).toHaveLength(1);
    expect((await chamada(turma.id, [alunos.ana])).json().error.code).toBe("TURMA_INATIVA");
  });

  it("adds and removes members idempotently", async () => {
    const turma = (await novaTurma({ nome: "Muay Thai 18h", alunos: [alunos.ana] })).json();
    const add = await request("POST", `/turmas/${turma.id}/alunos`, {
      user_ids: [alunos.ana, alunos.bia],
    });
    expect(add.json()).toEqual({ adicionados: 1, ja_na_turma: 1 });
    expect(
      (await request("POST", `/turmas/${turma.id}/alunos`, { user_ids: [alunos.bia, alunos.bia] }))
        .statusCode,
    ).toBe(400);
    expect((await request("DELETE", `/turmas/${turma.id}/alunos/${alunos.ana}`)).statusCode).toBe(
      204,
    );
    expect((await request("DELETE", `/turmas/${turma.id}/alunos/${alunos.ana}`)).statusCode).toBe(
      404,
    );
    expect((await request("GET", `/turmas/${turma.id}`)).json().total_alunos).toBe(1);
  });

  it("records the roll call in attendance once per class per day", async () => {
    const turma = (
      await novaTurma({ nome: "Turma Chamada", alunos: [alunos.ana, alunos.bia, alunos.caio] })
    ).json();
    const r1 = await chamada(turma.id, [alunos.ana, alunos.bia], professorToken);
    expect(r1.statusCode).toBe(200);
    expect(r1.json().registrados.sort()).toEqual([alunos.ana, alunos.bia].sort());
    expect(await registros(alunos.ana)).toEqual([turma.id]);
    expect(await presencas(alunos.ana)).toBe(1);
    // reenviar a mesma chamada não duplica
    const r2 = (await chamada(turma.id, [alunos.ana, alunos.bia, alunos.caio])).json();
    expect(r2.ja_presentes.sort()).toEqual([alunos.ana, alunos.bia].sort());
    expect(r2.registrados).toEqual([alunos.caio]);
    expect(await registros(alunos.ana)).toHaveLength(1);
    expect(await presencas(alunos.ana)).toBe(1);
    // a lista da chamada mostra quem já está presente hoje
    const lista = (await request("GET", `/turmas/${turma.id}/chamada`)).json();
    expect(lista.alunos.every((a: { presente_hoje: boolean }) => a.presente_hoje)).toBe(true);
    // aluno que não é da turma
    const fora = await chamada(turma.id, [alunos.fora]);
    expect(fora.statusCode).toBe(400);
    expect(fora.json().error.code).toBe("ALUNO_FORA_DA_TURMA");
    expect(await registros(alunos.fora)).toEqual([]);
  });

  it("links today's walk-in check-in instead of counting twice, and blocks delinquent students", async () => {
    const turma = (
      await novaTurma({ nome: "Turma Regras", alunos: [alunos.ana, alunos.bia, alunos.caio] })
    ).json();
    // ana passou o QR na recepção antes da aula
    expect((await request("POST", "/presencas/check-in", { user_id: alunos.ana })).statusCode).toBe(
      201,
    );
    expect(await presencas(alunos.ana)).toBe(1);
    // bia está inadimplente (vencida há 10 dias, carência 5)
    await debt(alunos.bia, 10);
    // a lista da chamada já avisa (situação calculada agora, não users.status antigo)
    const antes = (await request("GET", `/turmas/${turma.id}/chamada`)).json();
    expect(antes.alunos.find((a: { user_id: string }) => a.user_id === alunos.bia).status).toBe(
      "inadimplente",
    );
    expect((await one(db, "SELECT status FROM users WHERE id=$1", [alunos.bia])).status).toBe(
      "ativo",
    ); // prova de que o status gravado ainda estava desatualizado
    // caio está com sessão aberta de outra turma
    const outra = (await novaTurma({ nome: "Turma Anterior", alunos: [alunos.caio] })).json();
    expect((await chamada(outra.id, [alunos.caio])).json().registrados).toEqual([alunos.caio]);

    const res = (await chamada(turma.id, [alunos.ana, alunos.bia, alunos.caio])).json();
    expect(res.vinculados).toEqual([alunos.ana]);
    expect(res.bloqueados).toEqual([{ user_id: alunos.bia, status: "inadimplente" }]);
    expect(res.em_outra_turma).toEqual([alunos.caio]);
    expect(res.registrados).toEqual([]);
    expect(await registros(alunos.ana)).toEqual([turma.id]); // o check-in avulso virou desta turma
    expect(await presencas(alunos.ana)).toBe(1); // sem contar duas vezes
    expect(await registros(alunos.bia)).toEqual([]);
  });

  it("keeps management admin-only and the roll call staff-only", async () => {
    const turma = (await novaTurma({ nome: "Turma RBAC", alunos: [alunos.ana] })).json();
    expect((await novaTurma({ nome: "Prof cria" }, professorToken)).statusCode).toBe(403);
    expect(
      (await request("PATCH", `/turmas/${turma.id}`, { nome: "Outro" }, professorToken)).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          "POST",
          `/turmas/${turma.id}/alunos`,
          { user_ids: [alunos.bia] },
          professorToken,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request(
          "DELETE",
          `/turmas/${turma.id}/alunos/${alunos.ana}`,
          undefined,
          professorToken,
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (await request("GET", `/turmas/${turma.id}/chamada`, undefined, professorToken)).statusCode,
    ).toBe(200);
    for (const [verb, path, body] of [
      ["GET", "/turmas", undefined],
      ["GET", `/turmas/${turma.id}/chamada`, undefined],
      ["POST", `/turmas/${turma.id}/chamada`, { presentes: [alunos.ana] }],
    ] as const) {
      expect((await request(verb, path, body, studentToken)).statusCode, `${verb} ${path}`).toBe(
        403,
      );
      expect((await request(verb, path, body, "")).statusCode, `${verb} ${path}`).toBe(401);
    }
    expect((await request("GET", `/turmas/${randomUUID()}`)).statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// IMC calculado no servidor + check-in pelo scanner de QR
// ---------------------------------------------------------------------------
describe("server-side BMI on the student profile", () => {
  const medir = (altura: number | null, peso: number | null) =>
    db.query("UPDATE aluno_profile SET altura=$2, peso=$3 WHERE user_id=$1", [
      student,
      altura,
      peso,
    ]);
  const perfil = async () =>
    (await request("GET", "/me/perfil", undefined, studentToken)).json().perfil;

  it("returns imc = peso / altura², rounded, with the WHO adult class", async () => {
    // pelo PATCH do próprio aluno: 81 / 1,80² = 25,0
    const res = await request("PATCH", "/me/perfil", { altura: 1.8, peso: 81 }, studentToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().perfil).toMatchObject({ imc: 25, imc_classificacao: "sobrepeso" });
    for (const [altura, peso, imc, classe] of [
      [1.75, 53, 17.3, "abaixo_do_peso"],
      [1.75, 70, 22.9, "normal"],
      [1.7, 95, 32.9, "obesidade"],
      // 80,99 / 3,24 = 24,996 → exibido 25,0 → classificado pelo valor exibido
      [1.8, 80.99, 25, "sobrepeso"],
      [1.8, 58.31, 18, "abaixo_do_peso"],
    ] as const) {
      await medir(altura, peso);
      expect(await perfil(), `${altura} m, ${peso} kg`).toMatchObject({
        imc,
        imc_classificacao: classe,
      });
    }
    // o gestor recebe o mesmo cálculo na ficha do aluno
    expect((await request("GET", `/alunos/${student}`)).json().perfil).toMatchObject({
      imc: 18,
      imc_classificacao: "abaixo_do_peso",
    });
  });

  it("returns null without both measures and no adult class for minors", async () => {
    await medir(1.8, null);
    expect(await perfil()).toMatchObject({ imc: null, imc_classificacao: null });
    await medir(null, 70);
    expect(await perfil()).toMatchObject({ imc: null, imc_classificacao: null });
    const responsavel = (
      await one(
        db,
        `INSERT INTO responsaveis(nome, parentesco, whatsapp, telefone_emergencia)
         VALUES ('Resp Teste', 'mae', '5511900001111', '5511900002222') RETURNING id`,
      )
    ).id;
    await db.query(
      "UPDATE aluno_profile SET data_nascimento=$2, responsavel_id=$3 WHERE user_id=$1",
      [student, shift(todaySP(), -12), responsavel],
    );
    await medir(1.5, 45);
    expect(await perfil()).toMatchObject({ imc: 20, imc_classificacao: "menor_de_idade" });
  });
});

describe("QR scanner check-in (POST /presencas/check-in with qr_token)", () => {
  const qr = (sub: string, exp: string | number = "90s") =>
    new SignJWT({ typ: "carteirinha" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(sub)
      .setIssuer("bonsai")
      .setAudience("bonsai-reception")
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(config.JWT_QR_SECRET));
  const scan = (qr_token: string, token = adminToken) =>
    request("POST", "/presencas/check-in", { qr_token }, token);

  it("checks the student in from the card's QR and returns who entered", async () => {
    // QR real gerado pela carteirinha do aluno
    const { qr_token } = (await request("GET", "/me/carteirinha", undefined, studentToken)).json();
    const res = await scan(qr_token);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      user_id: student,
      check_out: null,
      aluno: { id: student, nome: "Pessoa Teste", modalidade: "jiu_jitsu" },
    });
    expect(res.json().aluno).not.toHaveProperty("email");
    // ler o mesmo aluno de novo: já está dentro
    const repetido = await scan(qr_token);
    expect(repetido.statusCode).toBe(409);
    expect(repetido.json().error.code).toBe("CHECKIN_JA_ABERTO");
  });

  it("works for professors too and blocks delinquent students, naming them", async () => {
    await user("prof.scanner@example.test", "professor");
    const professorToken = (
      await request("POST", "/auth/login", { email: "prof.scanner@example.test", password }, "")
    ).json().access_token;
    expect((await scan(await qr(student), professorToken)).statusCode).toBe(201);
    await debt(other, 10);
    const bloqueado = await scan(await qr(other));
    expect(bloqueado.statusCode).toBe(403);
    expect(bloqueado.json().error).toMatchObject({
      code: "CARTEIRINHA_BLOQUEADA",
      details: { status: "inadimplente", aluno: { id: other } },
    });
    expect((await db.query("SELECT 1 FROM attendance WHERE user_id=$1", [other])).rowCount).toBe(0);
  });

  it("rejects QRs that are expired, forged or not from a student", async () => {
    for (const [rotulo, token] of [
      ["expirado", await qr(student, Math.floor(Date.now() / 1000) - 10)],
      ["de um gestor", await qr(admin)],
      ["de ninguém", await qr(randomUUID())],
      [
        "assinado com outra chave",
        await new SignJWT({ typ: "carteirinha" })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(student)
          .setIssuer("bonsai")
          .setAudience("bonsai-reception")
          .setExpirationTime("90s")
          .sign(new TextEncoder().encode("x".repeat(40))),
      ],
      ["texto qualquer", "https://exemplo.com/nao-e-carteirinha"],
    ] as const) {
      const res = await scan(token);
      expect(res.statusCode, rotulo).toBe(400);
      expect(res.json().error.code, rotulo).toBe("QR_INVALIDO");
    }
    expect((await scan(await qr(student), studentToken)).statusCode).toBe(403);
    expect((await db.query("SELECT 1 FROM attendance")).rowCount).toBe(0);
  });
});
