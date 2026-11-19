import pg from "pg";
import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { route, fail, STAFF, type Context } from "./http.js";

export function presenceStream(app: FastifyInstance, ctx: Context) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let connection: pg.Client | undefined;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const clients = new Set<() => void>();
  const perUser = new Map<string, number>();
  async function connect() {
    if (stopped) return;
    const client = new pg.Client({
      connectionString: ctx.config.DATABASE_URL,
      application_name: "bonsai-listener",
      connectionTimeoutMillis: 5000,
    });
    connection = client;
    let reconnecting = false;
    const reconnect = () => {
      if (stopped || reconnecting) return;
      reconnecting = true;
      for (const close of clients) close();
      void client.end().catch(() => {});
      retry = setTimeout(() => void connect(), 2000);
      retry.unref();
    };
    client.on("error", reconnect);
    client.on("end", reconnect);
    client.on("notification", (n) => {
      if (n.channel === "presenca_evento" && n.payload) events.emit("presence", n.payload);
    });
    try {
      await client.connect();
      if (stopped) {
        await client.end();
        return;
      }
      await client.query("LISTEN presenca_evento");
    } catch {
      reconnect();
    }
  }
  app.addHook("onReady", async () => {
    await connect();
  });
  app.addHook("preClose", async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    for (const close of clients) close();
    await connection?.end().catch(() => {});
  });
  route(app, ctx, "GET", "/presencas/stream", { role: STAFF }, async (r, reply) => {
    if (clients.size >= 500 || (perUser.get(r.account.id) ?? 0) >= 3)
      fail(429, "RATE_LIMITED", "Limite de conexões ao vivo.");
    perUser.set(r.account.id, (perUser.get(r.account.id) ?? 0) + 1);
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined) reply.raw.setHeader(name, value);
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    let checking = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(expiry);
      events.off("presence", send);
      clients.delete(close);
      perUser.set(r.account.id, Math.max(0, (perUser.get(r.account.id) ?? 1) - 1));
      if (perUser.get(r.account.id) === 0) perUser.delete(r.account.id);
      reply.raw.end();
    };
    const send = (payload: string) => {
      if (!reply.raw.write(`event: presenca\ndata: ${payload}\n\n`)) close();
    };
    const heartbeat = setInterval(async () => {
      if (checking) return;
      checking = true;
      try {
        await ctx.authenticate(r);
        if (!closed && !reply.raw.write(": heartbeat\n\n")) close();
      } catch {
        close();
      } finally {
        checking = false;
      }
    }, 25000);
    const expiry = setTimeout(close, Math.max(1, r.tokenExp * 1000 - Date.now()));
    clients.add(close);
    events.on("presence", send);
    reply.raw.on("close", close);
    reply.raw.on("error", close);
    reply.raw.write(": connected\n\n");
  });
}
