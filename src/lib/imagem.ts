/**
 * Regras de imagem compartilhadas por API e front (foto de perfil e foto de
 * produto). Sem Zod e sem DOM: pode ser importado pelo servidor e pelo bundle.
 */

/** Formatos aceitos no upload (o app converte qualquer foto para um deles). */
export const FOTO_MIMES = ["image/webp", "image/jpeg"] as const;
export type FotoMime = (typeof FOTO_MIMES)[number];
/** Limite do upload. O app envia ≈40 KB (512 px), então sobra muita folga. */
export const FOTO_MAX_BYTES = 512 * 1024;
/** Lado do quadrado gerado no aparelho antes do envio. */
export const FOTO_LADO_PX = 512;
