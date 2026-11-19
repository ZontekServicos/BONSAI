/**
 * Valida imagem no limite de confiança do servidor (LOJA-03).
 *
 * O arquivo precisa ser decodificado por completo e é regravado sem metadados
 * (EXIF/GPS). Magic bytes falsos, arquivos truncados e conteúdo ativo
 * disfarçado não chegam ao banco. O limite de pixels reduz o risco de bomba
 * de descompressão. A redução feita no aparelho continua existindo só como UX.
 */
import sharp from "sharp";
import { FOTO_MAX_BYTES, type FotoMime } from "../../../src/lib/imagem.js";

const FORMATOS: Record<FotoMime, "jpeg" | "webp"> = {
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};
const MAX_PIXELS = 4096 * 4096;

export async function normalizarImagem(
  dados: Buffer,
  contentType: string | undefined,
): Promise<{ dados: Buffer; mime: FotoMime } | null> {
  const mime = contentType?.split(";", 1)[0].trim() as FotoMime | undefined;
  if (!mime || !(mime in FORMATOS) || dados.length < 100 || dados.length > FOTO_MAX_BYTES)
    return null;
  try {
    const imagem = sharp(dados, { failOn: "error", limitInputPixels: MAX_PIXELS });
    const metadata = await imagem.metadata();
    if (
      metadata.format !== FORMATOS[mime] ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS
    )
      return null;
    const base = imagem.rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true });
    const limpos =
      mime === "image/jpeg"
        ? await base.jpeg({ quality: 85, mozjpeg: true }).toBuffer()
        : await base.webp({ quality: 85 }).toBuffer();
    if (limpos.length < 100 || limpos.length > FOTO_MAX_BYTES) return null;
    return { dados: limpos, mime };
  } catch {
    return null;
  }
}
