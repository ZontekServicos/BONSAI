/**
 * Preparo de imagem NO APARELHO (foto de perfil e foto de produto): recorta
 * em quadrado, reduz para 512 px e regrava em WebP (ou JPEG). Regravar no
 * canvas descarta os metadados da câmera (EXIF/GPS). Só para o navegador.
 */
import { FOTO_LADO_PX, FOTO_MAX_BYTES } from "./imagem";

const paraBlob = (c: HTMLCanvasElement, tipo: string, q: number) =>
  new Promise<Blob | null>((ok) => c.toBlob(ok, tipo, q));
const paraDataURL = (b: Blob) =>
  new Promise<string>((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => erro(r.error);
    r.readAsDataURL(b);
  });

export async function prepararImagem(file: File): Promise<{ blob: Blob; preview: string }> {
  if (!file.type.startsWith("image/")) throw new Error("Escolha um arquivo de imagem.");
  let bmp: ImageBitmap;
  try {
    // imageOrientation padrão = "from-image": respeita a rotação da câmera.
    bmp = await createImageBitmap(file);
  } catch {
    throw new Error("Não foi possível abrir esta imagem. Tente outra foto (JPEG ou PNG).");
  }
  const lado = Math.min(bmp.width, bmp.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = FOTO_LADO_PX;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("Seu navegador não conseguiu processar a imagem.");
  g.imageSmoothingQuality = "high";
  g.drawImage(
    bmp,
    (bmp.width - lado) / 2,
    (bmp.height - lado) / 2,
    lado,
    lado,
    0,
    0,
    FOTO_LADO_PX,
    FOTO_LADO_PX,
  );
  bmp.close();
  // WebP onde houver suporte; senão JPEG (Safari antigo devolve PNG para webp).
  let blob = await paraBlob(canvas, "image/webp", 0.85);
  if (!blob || blob.type !== "image/webp") blob = await paraBlob(canvas, "image/jpeg", 0.85);
  if (blob && blob.size > FOTO_MAX_BYTES) blob = await paraBlob(canvas, "image/jpeg", 0.7);
  if (!blob) throw new Error("Seu navegador não conseguiu processar a imagem.");
  return { blob, preview: await paraDataURL(blob) };
}
