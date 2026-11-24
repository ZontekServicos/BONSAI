/**
 * Painel de gestão ativa das mensalidades (gestor e professor).
 *
 * Abas Todos / Pendentes / Pagos filtram no servidor (?status=). Enquanto a
 * resposta não chega, a lista atual já é filtrada no aparelho, então a troca
 * de aba é instantânea.
 *
 * Baixa rápida (só gestor, `podeDarBaixa`): "Dar baixa" no cartão pendente →
 * modal com valor ajustável → POST /financeiro/baixa. No sucesso o cartão vira
 * verde na hora (estado local), sem recarregar a lista: o aluno continua
 * visível na aba em que a baixa foi feita até a próxima troca de aba/busca.
 * O professor não recebe valores da API e não vê o botão.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CheckCircle2, CircleAlert, HandCoins, LoaderCircle, Search, X } from "lucide-react";
import type {
  BaixaMensalidade,
  BaixaMensalidadeInput,
  MensalidadePainelItem,
  MetodoPagamento,
  PainelMensalidades as Painel,
  StatusMensalidadePainel,
} from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { Card, Loading, Pager, amount, brl, day, labels, methods, useResource } from "./ui";

type Aba = "" | StatusMensalidadePainel;
const ABAS: { id: Aba; rotulo: string; chave: "todos" | StatusMensalidadePainel }[] = [
  { id: "", rotulo: "Todos", chave: "todos" },
  { id: "pendente", rotulo: "Pendentes", chave: "pendente" },
  { id: "pago", rotulo: "Pagos", chave: "pago" },
];

/** Baixas feitas nesta tela, por payment_id (estado local até o próximo fetch). */
type Baixas = Record<string, { pago_em: string; aba: Aba }>;

const mesAno = (competencia?: string) => {
  if (!competencia) return "";
  const [a, m] = competencia.split("-").map(Number);
  const nome = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(
    new Date(a, m - 1, 1),
  );
  return nome[0].toUpperCase() + nome.slice(1);
};

function Badge({ status }: { status: StatusMensalidadePainel }) {
  return status === "pago" ? (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-success/50 bg-success/15 px-3 py-1 text-xs font-bold text-success">
      <CheckCircle2 size={14} aria-hidden="true" /> Pago
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/60 bg-primary-strong/20 px-3 py-1 text-xs font-bold text-primary-soft">
      <CircleAlert size={14} aria-hidden="true" /> Pendente
    </span>
  );
}

export function PainelMensalidades({
  tick = 0,
  podeDarBaixa = false,
  onBaixa,
}: {
  tick?: number;
  /** Só o gestor: mostra "Dar baixa" (a API também exige admin). */
  podeDarBaixa?: boolean;
  /** Avisa a tela de cima (resumo, cobranças) sem recarregar este painel. */
  onBaixa?: () => void;
}) {
  const [aba, setAba] = useState<Aba>("");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [busca, setBusca] = useState("");
  const [baixas, setBaixas] = useState<Baixas>({});
  const [selecionado, setSelecionado] = useState<MensalidadePainelItem>();
  const [aviso, setAviso] = useState("");
  useEffect(() => {
    const t = setTimeout(() => {
      setBusca(q.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const params = new URLSearchParams({ page: String(page) });
  if (aba) params.set("status", aba);
  if (busca) params.set("q", busca);
  const r = useResource<Painel>(`/financeiro/mensalidades?${params}`, tick);

  const servidor = r.data?.data ?? [];
  // Baixa local sobre a resposta do servidor: o cartão fica verde na hora.
  const comBaixas = servidor.map((i) => {
    const b = i.payment_id ? baixas[i.payment_id] : undefined;
    return b && i.status === "pendente"
      ? { ...i, status: "pago" as const, pago_em: b.pago_em, recemPago: b.aba === aba }
      : { ...i, recemPago: false };
  });
  // Filtro imediato sobre a lista atual enquanto o servidor responde. Quem
  // acabou de receber baixa nesta aba continua visível (agora verde).
  const itens = comBaixas.filter((i) => !aba || i.status === aba || i.recemPago);
  // Contadores: o servidor ainda conta como pendente quem recebeu baixa local.
  const ajuste = servidor.filter(
    (i) => i.status === "pendente" && i.payment_id && baixas[i.payment_id],
  ).length;
  const resumo = r.data && {
    todos: r.data.resumo.todos,
    pago: r.data.resumo.pago + ajuste,
    pendente: r.data.resumo.pendente - ajuste,
  };

  function trocarAba(id: Aba) {
    setAba(id);
    setPage(1);
    setAviso("");
  }

  return (
    <Card title={`Mensalidades · ${mesAno(r.data?.competencia)}`}>
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/*
          Até 320px: rótulos e contadores encolhem (text-xs, px-2) e cabem lado a
          lado. Se ainda faltar espaço (contadores grandes, fonte ampliada), a
          rolagem fica DENTRO da barra de abas (overflow-x-auto + min-w-0), nunca
          na página.
        */}
        <div
          role="tablist"
          aria-label="Filtrar por status"
          className="flex w-full min-w-0 max-w-full gap-0.5 overflow-x-auto overscroll-x-contain rounded-full border border-border bg-surface-raised p-1 [scrollbar-width:none] sm:w-auto sm:gap-1 [&::-webkit-scrollbar]:hidden"
        >
          {ABAS.map((t) => (
            <button
              key={t.chave}
              role="tab"
              type="button"
              aria-selected={aba === t.id}
              onClick={() => trocarAba(t.id)}
              className={`inline-flex h-10 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-bold transition min-[360px]:gap-1.5 min-[360px]:px-3 min-[360px]:text-sm sm:flex-none sm:gap-2 sm:px-5 ${
                aba === t.id
                  ? "bg-primary-strong text-text-main"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {t.rotulo}
              {resumo && (
                <span className="rounded-full bg-secondary/40 px-1.5 text-xs tabular-nums min-[360px]:px-2">
                  {resumo[t.chave]}
                </span>
              )}
            </button>
          ))}
        </div>
        <label className="flex h-11 w-full items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 text-text-muted focus-within:border-primary sm:w-64">
          <Search size={16} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar aluno"
            aria-label="Buscar aluno"
            // `!`: o CSS legado `.workspace-body input` (fora de camada) venceria os utilitários
            className="h-full min-w-0 flex-1 rounded-none! border-0! bg-transparent! p-0! text-base text-text-main placeholder:text-text-muted focus-visible:outline-none sm:text-sm"
          />
        </label>
      </div>

      <p
        role="status"
        aria-live="polite"
        className={aviso ? "mt-3 text-sm text-success" : "sr-only"}
      >
        {aviso}
      </p>
      <Loading loading={r.loading && !r.data} error={r.error} />
      <ul role="tabpanel" aria-busy={r.loading} className="mt-4 grid gap-2">
        {itens.map((i) => {
          const podeBaixar = podeDarBaixa && i.status === "pendente" && !!i.payment_id && !!i.valor;
          return (
            <li
              key={i.user_id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-l-4 border-border px-4 py-3 transition-colors duration-500 ${
                i.status === "pago" ? "border-l-success" : "border-l-primary"
              } ${i.recemPago ? "bg-success/10" : "bg-surface-raised"}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-text-main">{i.nome}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  Vence em {day(i.data_vencimento)}
                  {!i.cobranca_gerada && " · cobrança ainda não gerada"}
                  {" · "}
                  {labels[i.modalidade]}
                  {podeDarBaixa && i.valor && (
                    <>
                      {" · "}
                      <span className="tabular-nums">{brl(i.valor)}</span>
                    </>
                  )}
                </p>
              </div>
              <Badge status={i.status} />
              {podeBaixar && (
                <button
                  type="button"
                  onClick={() => {
                    setAviso("");
                    setSelecionado(i);
                  }}
                  aria-label={`Dar baixa na mensalidade de ${i.nome}`}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-primary-strong px-4 text-sm font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary sm:w-auto"
                >
                  <HandCoins size={16} aria-hidden="true" /> Dar baixa
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {r.data && itens.length === 0 && !r.loading && (
        <p className="py-8 text-center text-text-muted">
          {aba === "pendente"
            ? "Nenhuma mensalidade pendente neste mês."
            : aba === "pago"
              ? "Nenhum pagamento registrado neste mês."
              : "Nenhum aluno ativo encontrado."}
        </p>
      )}
      <Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />

      {/* key: cada cobrança monta o próprio <dialog> (showModal roda na montagem) */}
      {selecionado && (
        <ConfirmarBaixa
          key={selecionado.payment_id}
          item={selecionado}
          onClose={() => setSelecionado(undefined)}
          onSucesso={(res) => {
            setBaixas((b) => ({
              ...b,
              [res.mensalidade.payment_id]: { pago_em: res.lancamento.data, aba },
            }));
            setAviso(`Baixa registrada: ${selecionado.nome}, ${brl(res.lancamento.valor)}.`);
            setSelecionado(undefined);
            onBaixa?.();
          }}
        />
      )}
    </Card>
  );
}

function ConfirmarBaixa({
  item,
  onClose,
  onSucesso,
}: {
  item: MensalidadePainelItem;
  onClose: () => void;
  onSucesso: (r: BaixaMensalidade) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const cobrado = item.valor ?? "0.00";
  const [valor, setValor] = useState(cobrado.replace(".", ","));
  const [metodo, setMetodo] = useState<MetodoPagamento>("pix");
  const [enviando, setEnviando] = useState(false);
  const [falha, setFalha] = useState("");

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  let normalizado = "";
  let invalido = "";
  try {
    normalizado = amount(valor.trim());
    if (normalizado === "0.00") invalido = "O valor recebido precisa ser maior que zero.";
  } catch (e) {
    invalido = errorMessage(e);
  }
  const diferente = !invalido && normalizado !== cobrado;

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    if (invalido || enviando) return;
    setEnviando(true);
    setFalha("");
    try {
      const body: BaixaMensalidadeInput = {
        payment_id: item.payment_id!,
        valor_pago: normalizado,
        metodo_pagamento: metodo,
      };
      onSucesso(await api<BaixaMensalidade>("/financeiro/baixa", { method: "POST", body }));
    } catch (err) {
      setFalha(errorMessage(err));
      setEnviando(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && !enviando && onClose()}
      aria-labelledby="baixa-titulo"
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-border bg-surface p-0 text-text-main backdrop:bg-secondary/75 backdrop:backdrop-blur-sm sm:m-auto sm:w-[min(440px,calc(100%-2rem))] sm:rounded-3xl"
    >
      <form
        onSubmit={(e) => void confirmar(e)}
        className="flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-[0.2em] text-text-muted uppercase">
              Baixa de mensalidade
            </p>
            <h2
              id="baixa-titulo"
              className="mt-1 font-display text-2xl leading-tight font-black uppercase italic"
            >
              Confirmar recebimento de {brl(invalido ? cobrado : normalizado)} para {item.nome}?
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Vencimento {day(item.data_vencimento)} · {labels[item.modalidade]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={enviando}
            aria-label="Fechar"
            className="grid size-11 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-surface-raised hover:text-text-main"
          >
            <X size={22} />
          </button>
        </div>

        <label className="grid gap-1.5 text-sm font-semibold">
          Valor recebido (R$)
          <input
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            // showModal() foca este campo em vez do botão "Fechar"
            autoFocus
            aria-invalid={!!invalido}
            aria-describedby="baixa-valor-ajuda"
            className="h-12 rounded-xl text-lg tabular-nums"
          />
          <span
            id="baixa-valor-ajuda"
            className={`text-xs font-normal ${invalido ? "text-primary-soft" : "text-text-muted"}`}
          >
            {invalido ||
              (diferente
                ? `Diferente do cobrado (${brl(cobrado)}). O caixa registra ${brl(normalizado)}.`
                : "Ajuste se o aluno pagou a mais ou a menos.")}
          </span>
        </label>

        <label className="grid gap-1.5 text-sm font-semibold">
          Forma de pagamento
          <select
            value={metodo}
            onChange={(e) => setMetodo(e.target.value as MetodoPagamento)}
            className="h-12 rounded-xl"
          >
            {methods.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>

        {falha && (
          <p
            role="alert"
            className="rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm"
          >
            {falha}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando || !!invalido}
          className="inline-flex h-13 items-center justify-center gap-2 rounded-full bg-primary-strong px-6 text-base font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {enviando ? (
            <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 size={20} aria-hidden="true" />
          )}
          Confirmar Recebimento
        </button>
      </form>
    </dialog>
  );
}
