import { beforeAll, beforeEach, afterAll, describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
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
    NODE_ENV: "test",
  });
  db = createDatabase(config);
  await db.query(await readFile("database/schema.sql", "utf8"));
  await db.query(await readFile("database/migrations/0002_runtime.sql", "utf8"));
  await db.query(await readFile("database/migrations/0003_search.sql", "utf8"));
  await db.query(await readFile("database/migrations/0004_papeis_modalidades.sql", "utf8"));
  await db.query(await readFile("database/migrations/0005_cadastro_aluno.sql", "utf8"));
  await db.query(await readFile("database/migrations/0006_ajustes_ficha_professor.sql", "utf8"));
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
      (
        await request("POST", `/alunos/${id}/graduacoes`, { nivel_novo: "Intermediário" })
      ).statusCode,
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
    const search = (await request("GET", "/responsaveis?q=maria", undefined, professorToken)).json();
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
      expect((await register(cadastro({ pessoal }))).statusCode, JSON.stringify(pessoal)).toBe(
        400,
      );
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
      cadastro({ treino: { modalidade: "boxe", faixa: undefined, grau: undefined, nivel: "Intermediário" } }),
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
      db.query("INSERT INTO aluno_profile(user_id,modalidade,faixa) VALUES($1,'jiu_jitsu','Branca')", [
        u.id,
      ]),
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
    expect((await request("GET", "/auth/me", undefined, token)).json().user.role).toBe(
      "professor",
    );
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
      "migrations/0002_runtime.sql": "e87aa24d6ee1923c6576b55f9bc465af84f9b64dc74627ece42033a3c242458e",
      "migrations/0003_search.sql": "715febe997596745076107a10766f08ce908523fb588ce04a72313a31ed123c1",
      "migrations/0004_papeis_modalidades.sql":
        "0638c6b4726347402fcd2f0137a3ef70a046d235712a4f356a9b956c45655c66",
      // 0005 publicada no commit 54e215e
      "migrations/0005_cadastro_aluno.sql":
        "0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3",
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
