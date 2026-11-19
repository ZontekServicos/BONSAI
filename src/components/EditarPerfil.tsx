/**
 * Modal "Editar perfil" do aluno: foto, altura e peso.
 *
 * Foto: o aparelho recorta em quadrado, reduz para 512 px e regrava em WebP
 * (ou JPEG). Regravar no canvas descarta os metadados da câmera (EXIF/GPS),
 * então a localização da foto nunca sai do celular.
 */
import { useEffect, useRef, useState } from "react";
import { Camera, LoaderCircle, Trash2, X } from "lucide-react";
import type { AlunoProfile } from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { FOTO_LADO_PX, FOTO_MAX_BYTES, perfilEditavelSchema } from "../lib/perfil";
import { Avatar } from "./Perfil";

// ----------------------------------------------------------------------------
// Foto: recorte quadrado + redução + reencode (sem EXIF) no próprio aparelho
// ----------------------------------------------------------------------------
const paraBlob = (c: HTMLCanvasElement, tipo: string, q: number) =>
  new Promise<Blob | null>((ok) => c.toBlob(ok, tipo, q));
const paraDataURL = (b: Blob) =>
  new Promise<string>((ok, erro) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => erro(r.error);
    r.readAsDataURL(b);
  });

async function prepararFoto(file: File): Promise<{ blob: Blob; preview: string }> {
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

/** Só dígitos e UM separador decimal (vírgula ou ponto) — "82 quilos" vira "82". */
function soDecimal(v: string) {
  const s = v.replace(/[^\d.,]/g, "");
  const i = s.search(/[.,]/);
  return i < 0 ? s : s.slice(0, i + 1) + s.slice(i + 1).replace(/[.,]/g, "");
}
const paraCampo = (v: number | null) => (v == null ? "" : String(v).replace(".", ","));

// ----------------------------------------------------------------------------
// Modal "Editar perfil"
// ----------------------------------------------------------------------------
type FotoNova = { blob: Blob; preview: string } | "remover" | null;

export default function EditarPerfil({
  nome,
  perfil,
  aberto,
  onClose,
  onSaved,
}: {
  nome: string;
  perfil: AlunoProfile;
  aberto: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const arquivo = useRef<HTMLInputElement>(null);
  const [altura, setAltura] = useState(paraCampo(perfil.altura));
  const [peso, setPeso] = useState(paraCampo(perfil.peso));
  const [foto, setFoto] = useState<FotoNova>(null);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [falha, setFalha] = useState("");
  const [processando, setProcessando] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (aberto && !d.open) {
      setAltura(paraCampo(perfil.altura));
      setPeso(paraCampo(perfil.peso));
      setFoto(null);
      setErros({});
      setFalha("");
      d.showModal();
    } else if (!aberto && d.open) d.close();
  }, [aberto, perfil]);

  async function escolher(file?: File) {
    if (!file) return;
    setProcessando(true);
    setFalha("");
    try {
      setFoto(await prepararFoto(file));
    } catch (e) {
      setFalha(errorMessage(e));
    } finally {
      setProcessando(false);
      if (arquivo.current) arquivo.current.value = "";
    }
  }

  async function salvar() {
    const medidas = { altura: altura.trim() || null, peso: peso.trim() || null };
    const mudou =
      medidas.altura !== (paraCampo(perfil.altura) || null) ||
      medidas.peso !== (paraCampo(perfil.peso) || null);
    if (mudou) {
      const r = perfilEditavelSchema.safeParse(medidas);
      if (!r.success) {
        const e: Record<string, string> = {};
        for (const i of r.error.issues) e[String(i.path[0] ?? "geral")] ??= i.message;
        setErros(e);
        return;
      }
    }
    setErros({});
    setFalha("");
    setSalvando(true);
    try {
      if (foto === "remover") await api("/me/foto", { method: "DELETE" });
      else if (foto) await api("/me/foto", { method: "PUT", raw: foto.blob });
      if (mudou) await api("/me/perfil", { method: "PATCH", body: medidas });
      onSaved();
      onClose();
    } catch (e) {
      setFalha(errorMessage(e));
    } finally {
      setSalvando(false);
    }
  }

  const fotoAtual = foto === "remover" ? null : foto ? foto.preview : perfil.foto_url;
  const ocupado = processando || salvando;
  const campo =
    "h-12 w-full min-w-0 rounded-xl border border-border-strong bg-surface-raised pl-3.5 pr-12 text-base text-text-main placeholder:text-text-muted focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25 aria-invalid:border-primary-soft";

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && !ocupado && onClose()}
      aria-labelledby="editar-perfil-titulo"
      className="m-0 mt-auto w-full max-w-none rounded-t-3xl border border-border bg-surface p-0 text-text-main backdrop:bg-secondary/75 backdrop:backdrop-blur-sm sm:m-auto sm:w-[min(440px,calc(100%-2rem))] sm:rounded-3xl"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void salvar();
        }}
        className="px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7"
      >
        <span aria-hidden="true" className="mx-auto mb-3 block h-1 w-10 rounded-full bg-border-strong sm:hidden" />
        <header className="flex items-center justify-between gap-4">
          <h2 id="editar-perfil-titulo" className="font-display text-3xl font-black uppercase italic">
            Editar perfil
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={salvando}
            aria-label="Fechar"
            className="grid size-11 place-items-center rounded-full text-text-muted transition hover:bg-surface-raised hover:text-text-main"
          >
            <X size={22} />
          </button>
        </header>

        <fieldset disabled={ocupado} className="mt-5 grid gap-5">
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <Avatar
                nome={nome}
                foto={fotoAtual}
                className="size-28 rounded-full border-2 border-border-strong bg-surface-raised text-4xl font-black text-primary-soft"
              />
              <button
                type="button"
                onClick={() => arquivo.current?.click()}
                aria-label={fotoAtual ? "Trocar foto" : "Adicionar foto"}
                className="absolute -right-1 -bottom-1 grid size-11 place-items-center rounded-full border-4 border-surface bg-primary-strong text-text-main shadow-lg transition hover:brightness-110"
              >
                {processando ? <LoaderCircle size={18} className="animate-spin" /> : <Camera size={18} />}
              </button>
              {/* Sem `capture`: o celular oferece câmera OU galeria. */}
              <input
                ref={arquivo}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                onChange={(e) => void escolher(e.target.files?.[0])}
              />
            </div>
            {fotoAtual && (
              <button
                type="button"
                onClick={() => setFoto("remover")}
                className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold text-text-muted transition hover:text-text-main"
              >
                <Trash2 size={15} /> Remover foto
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="grid content-start gap-1.5">
              <span className="text-sm font-semibold">Altura</span>
              <span className="relative">
                <input
                  value={altura}
                  onChange={(e) => setAltura(soDecimal(e.target.value))}
                  inputMode="decimal"
                  enterKeyHint="next"
                  placeholder="1,75"
                  maxLength={4}
                  aria-invalid={Boolean(erros.altura) || undefined}
                  className={campo}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3.5 grid place-items-center text-sm text-text-muted">
                  m
                </span>
              </span>
              {erros.altura && (
                <small role="alert" className="text-xs font-semibold text-primary-soft">
                  {erros.altura}
                </small>
              )}
            </label>
            <label className="grid content-start gap-1.5">
              <span className="text-sm font-semibold">Peso</span>
              <span className="relative">
                <input
                  value={peso}
                  onChange={(e) => setPeso(soDecimal(e.target.value))}
                  inputMode="decimal"
                  enterKeyHint="done"
                  placeholder="80,5"
                  maxLength={6}
                  aria-invalid={Boolean(erros.peso) || undefined}
                  className={campo}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3.5 grid place-items-center text-sm text-text-muted">
                  kg
                </span>
              </span>
              {erros.peso && (
                <small role="alert" className="text-xs font-semibold text-primary-soft">
                  {erros.peso}
                </small>
              )}
            </label>
          </div>
          <p className="-mt-2 text-xs text-text-muted">
            Altura em metros e peso em quilos. Deixe em branco para apagar.
          </p>

          {falha && (
            <p role="alert" className="rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm">
              {falha}
            </p>
          )}

          <button
            type="submit"
            className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary-strong font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary"
          >
            {salvando ? (
              <>
                <LoaderCircle size={20} className="animate-spin" /> Salvando…
              </>
            ) : (
              "Salvar"
            )}
          </button>
        </fieldset>
      </form>
    </dialog>
  );
}

