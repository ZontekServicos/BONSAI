/**
 * Loja do aluno: catálogo de intenção. O aluno vê os produtos e "Solicitar
 * Compra" registra o pedido e abre o WhatsApp da loja com a mensagem pronta.
 * Não há checkout: pagamento e entrega acontecem na academia.
 */
import { useEffect, useRef, useState } from "react";
import { ImageOff, LoaderCircle, MessageCircle, Search, X } from "lucide-react";
import type { PedidoLojaCriado, ProdutoLoja } from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { Loading, brl, useResource } from "./ui";

function Imagem({ produto, className = "" }: { produto: ProdutoLoja; className?: string }) {
  const [falhou, setFalhou] = useState(false);
  return produto.imagem_url && !falhou ? (
    <img
      src={produto.imagem_url}
      alt={produto.nome}
      loading="lazy"
      onError={() => setFalhou(true)}
      className={`aspect-square w-full object-cover ${className}`}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`grid aspect-square w-full place-items-center bg-surface-raised text-text-muted ${className}`}
    >
      <ImageOff size={32} />
    </span>
  );
}

function Estoque({ estoque }: { estoque: number }) {
  if (estoque <= 0)
    return (
      <span className="rounded-full border border-border-strong px-2.5 py-1 text-[11px] font-bold text-text-muted">
        Esgotado
      </span>
    );
  if (estoque <= 3)
    return (
      <span className="rounded-full border border-primary/60 px-2.5 py-1 text-[11px] font-bold text-primary-soft">
        Últimas unidades
      </span>
    );
  return null;
}

export function Loja() {
  const [q, setQ] = useState("");
  const [busca, setBusca] = useState("");
  const [aberto, setAberto] = useState<ProdutoLoja>();
  useEffect(() => {
    const t = setTimeout(() => setBusca(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const r = useResource<ProdutoLoja[]>(
    `/loja/produtos${busca ? `?q=${encodeURIComponent(busca)}` : ""}`,
  );

  return (
    <section className="mt-2">
      <label className="flex h-12 max-w-md items-center gap-3 rounded-2xl border border-border-strong bg-surface px-4 text-text-muted focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/25">
        <Search size={18} aria-hidden="true" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar produto"
          aria-label="Buscar produto"
          className="h-full min-w-0 flex-1 bg-transparent text-base text-text-main placeholder:text-text-muted focus-visible:outline-none"
        />
      </label>
      <Loading {...r} />
      {r.data?.length === 0 && (
        <p className="mt-10 text-center text-text-muted">
          {busca ? "Nenhum produto encontrado." : "A loja ainda não tem produtos disponíveis."}
        </p>
      )}
      {/* mobile-first: 2 colunas no celular, 3 no tablet, 4 no desktop */}
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
        {r.data?.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => setAberto(p)}
              className="group flex h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface text-left transition hover:-translate-y-0.5 hover:border-primary/70 focus-visible:outline-primary"
            >
              <span className="relative block overflow-hidden">
                <Imagem
                  produto={p}
                  className={`transition duration-300 group-hover:scale-105 ${p.estoque <= 0 ? "opacity-50 grayscale" : ""}`}
                />
                <span className="absolute top-2 left-2">
                  <Estoque estoque={p.estoque} />
                </span>
              </span>
              <span className="flex flex-1 flex-col gap-1 p-3 sm:p-4">
                <span className="line-clamp-2 text-sm font-semibold text-text-main sm:text-base">
                  {p.nome}
                </span>
                <span className="mt-auto pt-1 font-display text-xl font-black text-primary-soft sm:text-2xl">
                  {brl(p.preco)}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {/* key: cada produto monta o próprio <dialog> (showModal roda na montagem) */}
      {aberto && <Detalhes key={aberto.id} produto={aberto} onClose={() => setAberto(undefined)} />}
    </section>
  );
}

function Detalhes({ produto, onClose }: { produto: ProdutoLoja; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [enviando, setEnviando] = useState(false);
  const [falha, setFalha] = useState("");
  const [enviado, setEnviado] = useState(false);
  const esgotado = produto.estoque <= 0;

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  async function solicitar() {
    setEnviando(true);
    setFalha("");
    // Abre a aba já no clique (gesto do usuário); depois da resposta só troca o
    // endereço. Abrir só depois do await é bloqueado no Safari do iPhone.
    const aba = window.open("", "_blank");
    if (aba) aba.opener = null;
    try {
      const r = await api<PedidoLojaCriado>("/loja/pedido", {
        method: "POST",
        body: { produto_id: produto.id },
      });
      if (aba) aba.location.href = r.whatsapp_url;
      else window.location.href = r.whatsapp_url;
      setEnviado(true);
    } catch (e) {
      aba?.close();
      setFalha(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      aria-labelledby="produto-titulo"
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-border bg-surface p-0 text-text-main backdrop:bg-secondary/75 backdrop:backdrop-blur-sm sm:m-auto sm:w-[min(760px,calc(100%-2rem))] sm:rounded-3xl"
    >
      <div className="sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="relative">
          <Imagem produto={produto} className="sm:h-full" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="absolute top-3 right-3 grid size-11 place-items-center rounded-full bg-secondary/70 text-text-main backdrop-blur-sm transition hover:bg-secondary sm:hidden"
          >
            <X size={22} />
          </button>
        </div>
        <div className="flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-[0.2em] text-text-muted uppercase">
                {produto.categoria}
              </p>
              <h2
                id="produto-titulo"
                className="mt-1 font-display text-3xl leading-none font-black uppercase italic"
              >
                {produto.nome}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="hidden size-11 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-surface-raised hover:text-text-main sm:grid"
            >
              <X size={22} />
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-display text-4xl font-black text-primary-soft">
              {brl(produto.preco)}
            </span>
            <Estoque estoque={produto.estoque} />
          </div>
          <p className="text-[15px] leading-relaxed whitespace-pre-line text-text-muted">
            {produto.descricao || "Sem descrição."}
          </p>
          {falha && (
            <p
              role="alert"
              className="rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm"
            >
              {falha}
            </p>
          )}
          {enviado && (
            <p role="status" className="text-sm text-success">
              Pedido registrado. Finalize a conversa no WhatsApp; o pagamento e a retirada são na
              academia.
            </p>
          )}
          <button
            type="button"
            onClick={() => void solicitar()}
            disabled={enviando || esgotado}
            className="mt-auto inline-flex h-13 items-center justify-center gap-2 rounded-full bg-primary-strong px-6 text-base font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary disabled:cursor-not-allowed"
          >
            {enviando ? (
              <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
            ) : (
              <MessageCircle size={20} aria-hidden="true" />
            )}
            {esgotado ? "Esgotado" : "Solicitar Compra"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
