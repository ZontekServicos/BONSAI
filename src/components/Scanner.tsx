/**
 * Scanner de QR da carteirinha (Presença; gestor e professor).
 *
 * Escanear → abre a câmera traseira → lê o QR do aluno → POST
 * /presencas/check-in { qr_token } automaticamente. A API valida o QR
 * (assinatura, validade de 90 s, aluno existente) e a inadimplência antes de
 * registrar; a resposta já traz o nome/foto de quem entrou.
 *
 * Depois de cada leitura a câmera pausa, mostra o resultado e volta sozinha
 * para o próximo aluno. A biblioteca (html5-qrcode) só é baixada quando o
 * scanner abre: quem nunca escaneia não paga o peso dela.
 */
import { useEffect, useRef, useState } from "react";
import { CameraOff, CheckCircle2, CircleAlert, LoaderCircle, ScanLine, X } from "lucide-react";
import type { Html5Qrcode } from "html5-qrcode";
import type { AlunoResumo, CheckInResultado } from "../types/contract";
import { api, errorMessage, HttpError } from "../lib/api";
import { Avatar } from "./Perfil";
import { graduacaoTexto, labels } from "./ui";

/** Tempo mostrando o resultado antes de voltar a ler. */
const PAUSA_MS = 2500;

type Leitura =
  | { tipo: "lendo" }
  | { tipo: "enviando" }
  | { tipo: "ok"; aluno: AlunoResumo }
  | { tipo: "erro"; titulo: string; detalhe: string };

/** Mensagem curta para a recepção, a partir do erro da API. */
function explicar(e: unknown): { titulo: string; detalhe: string } {
  if (e instanceof HttpError) {
    const nome = (e.details as { aluno?: AlunoResumo } | undefined)?.aluno?.nome;
    switch (e.code) {
      case "CARTEIRINHA_BLOQUEADA":
        return {
          titulo: `Entrada bloqueada${nome ? `: ${nome}` : ""}`,
          detalhe: "Mensalidade em atraso. Encaminhe para a recepção regularizar.",
        };
      case "ALUNO_INATIVO":
        return { titulo: `Aluno inativo${nome ? `: ${nome}` : ""}`, detalhe: "Matrícula inativa." };
      case "CHECKIN_JA_ABERTO":
        return {
          titulo: "Entrada já registrada",
          detalhe: "Este aluno já está dentro da academia.",
        };
      case "QR_INVALIDO":
        return {
          titulo: "QR inválido ou expirado",
          detalhe: "Peça para o aluno abrir a carteirinha de novo (o QR renova a cada 90 s).",
        };
    }
  }
  return { titulo: "Não foi possível registrar", detalhe: errorMessage(e) };
}

/** Mensagem para falha ao abrir a câmera. */
function erroCamera(e: unknown) {
  const nome = (e as { name?: string })?.name ?? "";
  const texto = String((e as { message?: string })?.message ?? e);
  if (!window.isSecureContext) return "A câmera só funciona com o sistema aberto em HTTPS.";
  if (nome === "NotAllowedError" || /permission|denied/i.test(texto))
    return "Acesso à câmera negado. Libere a câmera para este site nas permissões do navegador.";
  if (nome === "NotFoundError" || /not ?found|no camera|requested device/i.test(texto))
    return "Nenhuma câmera encontrada neste aparelho.";
  if (nome === "NotReadableError")
    return "A câmera está em uso por outro aplicativo. Feche-o e tente de novo.";
  return "Não foi possível abrir a câmera.";
}

export function BotaoScanner({ onCheckIn }: { onCheckIn?: (r: CheckInResultado) => void }) {
  const [aberto, setAberto] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setAberto(true)}
        className="inline-flex h-14 w-full items-center justify-center gap-3 rounded-2xl bg-primary-strong px-6 text-base font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary sm:w-auto"
      >
        <ScanLine size={22} aria-hidden="true" /> Escanear carteirinha
      </button>
      {aberto && <ScannerModal onClose={() => setAberto(false)} onCheckIn={onCheckIn} />}
    </>
  );
}

function ScannerModal({
  onClose,
  onCheckIn,
}: {
  onClose: () => void;
  onCheckIn?: (r: CheckInResultado) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const leitor = useRef<Html5Qrcode>(null);
  const ocupado = useRef(false);
  const retomar = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [leitura, setLeitura] = useState<Leitura>({ tipo: "lendo" });
  const [falhaCamera, setFalhaCamera] = useState("");
  const [iniciando, setIniciando] = useState(true);
  const [total, setTotal] = useState(0);
  // Callback em ref: trocar a função do pai não pode reiniciar a câmera.
  const avisar = useRef(onCheckIn);
  avisar.current = onCheckIn;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let cancelado = false;
    async function registrar(texto: string) {
      if (ocupado.current) return;
      ocupado.current = true;
      leitor.current?.pause(true); // congela o vídeo no QR lido
      setLeitura({ tipo: "enviando" });
      try {
        const r = await api<CheckInResultado>("/presencas/check-in", {
          method: "POST",
          body: { qr_token: texto.trim() },
        });
        navigator.vibrate?.(80);
        setLeitura({ tipo: "ok", aluno: r.aluno });
        setTotal((n) => n + 1);
        avisar.current?.(r);
      } catch (e) {
        navigator.vibrate?.([60, 60, 60]);
        setLeitura({ tipo: "erro", ...explicar(e) });
      }
      retomar.current = setTimeout(() => {
        if (cancelado) return;
        setLeitura({ tipo: "lendo" });
        ocupado.current = false;
        try {
          leitor.current?.resume();
        } catch {
          /* já parado (modal fechando) */
        }
      }, PAUSA_MS);
    }

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("sem getUserMedia");
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (cancelado) return;
        const s = new Html5Qrcode("leitor-qr", {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
        });
        leitor.current = s;
        await s.start(
          { facingMode: "environment" },
          {
            fps: 10,
            // quadro de mira: 70% do menor lado do vídeo
            qrbox: (w, h) => {
              const lado = Math.floor(Math.min(w, h) * 0.7);
              return { width: lado, height: lado };
            },
            aspectRatio: 1,
          },
          (texto) => void registrar(texto),
          () => {
            /* quadro sem QR: normal, ignora */
          },
        );
        if (cancelado) await s.stop().catch(() => undefined);
      } catch (e) {
        if (!cancelado) setFalhaCamera(erroCamera(e));
      } finally {
        if (!cancelado) setIniciando(false);
      }
    })();

    return () => {
      cancelado = true;
      clearTimeout(retomar.current);
      const s = leitor.current;
      leitor.current = null;
      // Desliga a câmera (a luz do aparelho apaga) ao fechar.
      if (s?.isScanning)
        void s
          .stop()
          .then(() => s.clear())
          .catch(() => undefined);
    };
  }, []);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="scanner-titulo"
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto border-0 bg-background p-0 text-text-main backdrop:bg-secondary/90 sm:m-auto sm:h-auto sm:max-h-[92dvh] sm:w-[min(520px,calc(100%-2rem))] sm:rounded-3xl sm:border sm:border-border"
    >
      <div className="flex min-h-full flex-col gap-4 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2
              id="scanner-titulo"
              className="font-display text-2xl leading-tight font-black uppercase italic"
            >
              Escanear carteirinha
            </h2>
            <p className="text-xs text-text-muted" aria-live="polite">
              {total} entrada{total === 1 ? "" : "s"} registrada{total === 1 ? "" : "s"} nesta
              leitura
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar scanner"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-surface-raised text-text-main transition hover:bg-surface"
          >
            <X size={22} />
          </button>
        </div>

        {/* Vídeo da câmera (a biblioteca injeta o <video> aqui). */}
        <div className="relative mx-auto aspect-square w-full max-w-[420px] overflow-hidden rounded-2xl border border-border bg-surface">
          {/* div sem id = aviso "Scanner paused" (inglês) da biblioteca: o resultado já aparece abaixo */}
          <div
            id="leitor-qr"
            className="size-full [&_video]:size-full! [&_video]:object-cover! [&>div:not([id])]:hidden!"
          />
          {iniciando && !falhaCamera && (
            <p className="absolute inset-0 grid place-items-center text-sm text-text-muted">
              <span className="inline-flex items-center gap-2">
                <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Abrindo a
                câmera…
              </span>
            </p>
          )}
          {falhaCamera && (
            <div
              role="alert"
              className="absolute inset-0 grid place-content-center gap-3 p-6 text-center"
            >
              <CameraOff size={36} className="mx-auto text-primary-soft" aria-hidden="true" />
              <p className="text-sm">{falhaCamera}</p>
            </div>
          )}
        </div>

        <div aria-live="assertive" className="min-h-28">
          {leitura.tipo === "lendo" && !falhaCamera && !iniciando && (
            <p className="text-center text-sm text-text-muted">
              Aponte para o QR da carteirinha do aluno.
            </p>
          )}
          {leitura.tipo === "enviando" && (
            <p className="flex items-center justify-center gap-2 text-sm text-text-muted">
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Registrando…
            </p>
          )}
          {leitura.tipo === "ok" && (
            <div className="flex items-center gap-3 rounded-2xl border border-l-4 border-border border-l-success bg-success/10 p-3">
              <Avatar
                nome={leitura.aluno.nome}
                foto={leitura.aluno.foto_url}
                className="size-14 shrink-0 rounded-xl"
              />
              <div className="min-w-0 flex-1">
                <p className="inline-flex items-center gap-1.5 text-sm font-bold text-success">
                  <CheckCircle2 size={16} aria-hidden="true" /> Entrada registrada
                </p>
                <p className="truncate text-lg font-semibold">{leitura.aluno.nome}</p>
                <p className="text-xs text-text-muted">
                  {labels[leitura.aluno.modalidade]} · {graduacaoTexto(leitura.aluno)} · Matrícula{" "}
                  {leitura.aluno.numero_matricula}
                </p>
              </div>
            </div>
          )}
          {leitura.tipo === "erro" && (
            <div className="flex items-start gap-3 rounded-2xl border border-l-4 border-border border-l-primary bg-primary-strong/15 p-3">
              <CircleAlert
                size={22}
                className="mt-0.5 shrink-0 text-primary-soft"
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="font-bold">{leitura.titulo}</p>
                <p className="text-sm text-text-muted">{leitura.detalhe}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}
