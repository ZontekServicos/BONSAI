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
      "INSERT INTO aluno_profile(user_id,modalidade,faixa,data_matricula) VALUES($1,'jiu_jitsu','Faixa branca','2020-01-01')",
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
      faixa: "Iniciante",
      data_matricula: "2028-01-31",
      gerar_mensalidades: { valor: "120.00", dia_vencimento: 31, meses: 3 },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(
      (await one(db, "SELECT count(*)::int AS n FROM financeiro WHERE user_id=$1", [id])).n,
    ).toBe(3);
    expect(
      (
        await request("POST", `/alunos/${id}/graduacoes`, {
          faixa_nova: "Intermediário",
          graduacao_nova: 1,
        })
      ).statusCode,
    ).toBe(201);
    expect((await request("GET", `/alunos/${id}`)).json().perfil.graduacao_nivel).toBe(1);
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
