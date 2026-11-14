import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().url(),
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_QR_SECRET: z.string().min(32),
    CORS_ORIGIN: z.string().url(),
    COOKIE_SAME_SITE: z.enum(["strict", "lax", "none"]).default("strict"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PG_POOL_MAX: z.coerce.number().int().min(2).max(50).default(10),
    DIAS_CARENCIA: z.coerce.number().int().min(0).max(90).default(5),
    SERVE_WEB: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    BILLING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    BILLING_AMOUNT: z
      .string()
      .regex(/^\d{1,8}\.\d{2}$/)
      .default("150.00"),
    BILLING_DUE_DAY: z.coerce.number().int().min(1).max(31).default(10),
  })
  .refine((v) => v.JWT_ACCESS_SECRET !== v.JWT_QR_SECRET, "JWT secrets must differ")
  .refine(
    (v) =>
      v.NODE_ENV !== "production" ||
      (v.CORS_ORIGIN.startsWith("https://") &&
        !v.JWT_ACCESS_SECRET.startsWith("replace-") &&
        !v.JWT_QR_SECRET.startsWith("replace-")),
    "Production requires HTTPS and random secrets",
  )
  .refine(
    (v) => !v.BILLING_ENABLED || Number(v.BILLING_AMOUNT) > 0,
    "Billing amount must be positive",
  )
  .refine(
    (v) => v.COOKIE_SAME_SITE !== "none" || v.NODE_ENV === "production",
    "SameSite=None requires production HTTPS",
  );
export type Config = z.infer<typeof envSchema>;
export function readConfig(env = process.env): Config {
  return envSchema.parse(env);
}
