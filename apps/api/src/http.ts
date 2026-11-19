import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";
import { z } from "zod";
import type { User, UserRole } from "../../../src/types/contract.js";
import type { DB, Database } from "./db.js";
import type { Config } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    account: User;
    tokenExp: number;
  }
}
export class ApiFailure extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, code: string, message: string, details?: unknown): never {
  throw new ApiFailure(status, code, message, details);
}
export function found<T>(value: T | undefined): T {
  if (!value) fail(404, "NAO_ENCONTRADO", "Registro não encontrado.");
  return value;
}
export type Context = {
  db: Database;
  config: Config;
  authenticate: (r: FastifyRequest) => Promise<void>;
};
export const text = (max = 120) => z.string().trim().min(1).max(max);
export const uuid = z.string().uuid();
export const date = z.iso.date();
export const money = z.string().regex(/^(0|[1-9]\d{0,7})\.\d{2}$/);
export const positiveMoney = money.refine((v) => v !== "0.00", "Valor deve ser positivo");
export const method = z.enum([
  "pix",
  "dinheiro",
  "cartao_credito",
  "cartao_debito",
  "boleto",
  "transferencia",
]);
export const modality = z.enum(["boxe", "jiu_jitsu", "muay_thai", "mma"]);
export const page = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};
export const range = { de: date.optional(), ate: date.optional() };
export const empty = z.strictObject({});
/** Papéis com função pedagógica/recepção. Professor NÃO acessa financeiro, caixa, loja nem dashboard. */
export const STAFF: UserRole[] = ["admin", "professor"];
type Access = "public" | UserRole | UserRole[];
export function route<
  B extends z.ZodType = typeof empty,
  Q extends z.ZodType = typeof empty,
  P extends z.ZodType = typeof empty,
>(
  app: FastifyInstance,
  ctx: Context,
  verb: HTTPMethods,
  path: string,
  spec: { body?: B; query?: Q; params?: P; role?: Access },
  handler: (
    r: FastifyRequest,
    reply: FastifyReply,
    b: z.infer<B>,
    q: z.infer<Q>,
    p: z.infer<P>,
  ) => unknown,
) {
  app.route({
    method: verb,
    url: `/api/v1${path}`,
    preHandler: async (r) => {
      if (spec.role !== "public") {
        await ctx.authenticate(r);
        const allowed = spec.role === undefined || [spec.role].flat().includes(r.account.role);
        if (!allowed) fail(403, "SEM_PERMISSAO", "Acesso não permitido.");
      }
    },
    handler: (r, reply) =>
      handler(
        r,
        reply,
        (spec.body ?? empty).parse(r.body ?? {}) as z.infer<B>,
        (spec.query ?? empty).parse(r.query) as z.infer<Q>,
        (spec.params ?? empty).parse(r.params) as z.infer<P>,
      ),
  });
}
/** Staff (admin/professor) ou o próprio aluno. */
export function staffOrSelf(r: FastifyRequest, id: string) {
  if (!STAFF.includes(r.account.role) && r.account.id !== id)
    fail(403, "SEM_PERMISSAO", "Acesso não permitido.");
}
export function selfOrAdmin(r: FastifyRequest, id: string) {
  if (r.account.role !== "admin" && r.account.id !== id)
    fail(403, "SEM_PERMISSAO", "Acesso não permitido.");
}
export async function paginate(
  db: DB,
  sql: string,
  values: unknown[],
  q: { page: number; page_size: number },
) {
  // Separate count keeps total correct for a requested page beyond the last row.
  const orderAt = sql.lastIndexOf(" ORDER BY ");
  const countSQL = orderAt < 0 ? sql : sql.slice(0, orderAt);
  const count = await db.query(`SELECT count(*)::int AS total FROM (${countSQL}) results`, values);
  const rows = await db.query(`${sql} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [
    ...values,
    q.page_size,
    (q.page - 1) * q.page_size,
  ]);
  return { data: rows.rows, total: count.rows[0].total, ...q };
}
export function cents(value: string): bigint {
  const [a, b = "00"] = value.split(".");
  return BigInt(a) * 100n + BigInt(b.padEnd(2, "0"));
}
export function decimal(value: bigint): string {
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
