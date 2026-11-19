/**
 * Perfil editável pelo próprio aluno (foto, altura, peso) — COMPARTILHADO
 * entre API (PATCH /me/perfil, PUT /me/foto) e a tela "Minha jornada".
 */
import { z } from "zod";

/** Formatos aceitos no upload (o app converte qualquer foto para um deles). */
export const FOTO_MIMES = ["image/webp", "image/jpeg"] as const;
export type FotoMime = (typeof FOTO_MIMES)[number];
/** Limite do upload. O app envia ≈40 KB (512 px), então sobra muita folga. */
export const FOTO_MAX_BYTES = 512 * 1024;
/** Lado do quadrado gerado no aparelho antes do envio. */
export const FOTO_LADO_PX = 512;

/**
 * Número decimal "limpo": só dígitos e no máximo 2 casas, com ponto ou vírgula
 * ("82.5", "82,5"). Recusa "82 quilos", "1.85m", "1,8,5". Devolve string com
 * ponto (vai direto para o `numeric` do Postgres, sem erro de float).
 */
function medida(rotulo: string, unidade: string, min: number, max: number, exemplo: string) {
  return z
    .union([z.number(), z.string()], { error: `${rotulo}: informe um número.` })
    .transform((v) => String(v).trim().replace(",", "."))
    .pipe(
      z
        .string()
        .regex(/^\d{1,3}(\.\d{1,2})?$/, `${rotulo}: use só números, em ${unidade} (ex.: ${exemplo}).`)
        .refine(
          (v) => Number(v) >= min && Number(v) <= max,
          `${rotulo} deve ficar entre ${String(min).replace(".", ",")} e ${max} ${unidade}.`,
        ),
    );
}
export const alturaSchema = medida("Altura", "metros", 0.5, 2.5, "1.85");
export const pesoSchema = medida("Peso", "kg", 10, 300, "82.5");

/**
 * PATCH /me/perfil (alias PATCH /profile) — SÓ foto_url, altura e peso.
 * `null` apaga. `foto_url` só aceita null (remover) ou o link da foto que o
 * próprio aluno enviou em PUT /me/foto: link externo vindo do cliente viraria
 * imagem de terceiros/rastreador na tela da equipe. A API confere a posse.
 */
export const perfilEditavelSchema = z
  .strictObject({
    foto_url: z.string().max(300).nullable().optional(),
    altura: alturaSchema.nullable().optional(),
    peso: pesoSchema.nullable().optional(),
  })
  .refine(
    (b) => b.foto_url !== undefined || b.altura !== undefined || b.peso !== undefined,
    "Nada para atualizar.",
  );
export type PerfilEditavelInput = z.input<typeof perfilEditavelSchema>;

/** Confere a assinatura do arquivo (não confia só no Content-Type). */
export function formatoDaImagem(b: Uint8Array): FotoMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}
