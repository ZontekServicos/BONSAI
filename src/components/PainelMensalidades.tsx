/**
 * Painel de gestão ativa das mensalidades (gestor e professor).
 *
 * Abas Todos / Pendentes / Pagos filtram no servidor (?status=). Enquanto a
 * resposta não chega, a lista atual já é filtrada no aparelho, então a troca
 * de aba é instantânea. Sem valores: só aluno, vencimento e status do mês.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, CircleAlert, Search } from "lucide-react";
import type { PainelMensalidades as Painel, StatusMensalidadePainel } from "../types/contract";
import { Card, Loading, Pager, day, labels, useResource } from "./ui";

type Aba = "" | StatusMensalidadePainel;
const ABAS: { id: Aba; rotulo: string; chave: "todos" | StatusMensalidadePainel }[] = [
  { id: "", rotulo: "Todos", chave: "todos" },
  { id: "pendente", rotulo: "Pendentes", chave: "pendente" },
  { id: "pago", rotulo: "Pagos", chave: "pago" },
];

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

export function PainelMensalidades({ tick = 0 }: { tick?: number }) {
  const [aba, setAba] = useState<Aba>("");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [busca, setBusca] = useState("");
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
  // Filtro imediato sobre a lista atual enquanto o servidor responde.
  const itens = (r.data?.data ?? []).filter((i) => !aba || i.status === aba);

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
              onClick={() => {
                setAba(t.id);
                setPage(1);
              }}
              className={`inline-flex h-10 flex-1 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-bold transition min-[360px]:gap-1.5 min-[360px]:px-3 min-[360px]:text-sm sm:flex-none sm:gap-2 sm:px-5 ${
                aba === t.id
                  ? "bg-primary-strong text-text-main"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {t.rotulo}
              {r.data && (
                <span className="rounded-full bg-secondary/40 px-1.5 text-xs tabular-nums min-[360px]:px-2">
                  {r.data.resumo[t.chave]}
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

      <Loading loading={r.loading && !r.data} error={r.error} />
      <ul role="tabpanel" aria-busy={r.loading} className="mt-4 grid gap-2">
        {itens.map((i) => (
          <li
            key={i.user_id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-raised px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate font-semibold text-text-main">{i.nome}</p>
              <p className="mt-0.5 text-xs text-text-muted">
                Vence em {day(i.data_vencimento)}
                {!i.cobranca_gerada && " · cobrança ainda não gerada"}
                {" · "}
                {labels[i.modalidade]}
              </p>
            </div>
            <Badge status={i.status} />
          </li>
        ))}
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
    </Card>
  );
}
