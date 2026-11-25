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
 *
 * Cobrança por WhatsApp (só gestor, `podeCobrar`): checkbox nos pendentes +
 * "Cobrar Selecionados" → POST /notificacoes/cobrar para cada um (a API escolhe
 * o destinatário: responsável se o aluno for menor). As abas são abertas ainda
 * dentro do clique; o navegador costuma liberar só uma janela por clique, então
 * as demais ficam na "Fila de cobrança", cada uma com o próprio botão.
 * Um item só conta como "aberto" quando window.open() devolve a janela; se
 * vier null (pop-up bloqueado) ele continua na fila e aparece o aviso.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FilePlus2,
  Flag,
  HandCoins,
  LoaderCircle,
  MessageCircle,
  Search,
  X,
} from "lucide-react";
import type {
  BaixaMensalidade,
  BaixaMensalidadeInput,
  CobrancaWhatsApp,
  Financeiro,
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

/** Um item da fila de cobrança: link pronto (aberto ou não) ou erro da API. */
type ItemFila = { payment_id: string; nome: string; aberto: boolean } & (
  | { cobranca: CobrancaWhatsApp; erro?: undefined }
  | { cobranca?: undefined; erro: string }
);

/** Abre o link numa aba nova sem dar acesso a esta página (noopener). */
const abrirAba = () => {
  const w = window.open("", "_blank");
  if (w) w.opener = null;
  return w;
};

/** "2026-11" → "Novembro de 2026". */
export const mesAno = (competencia?: string) => {
  if (!competencia) return "";
  const [a, m] = competencia.split("-").map(Number);
  const nome = new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(
    new Date(a, m - 1, 1),
  );
  return nome[0].toUpperCase() + nome.slice(1);
};

/** Selo Pago (verde) / Pendente (vermelho). Também usado na área do aluno. */
export function Badge({ status }: { status: StatusMensalidadePainel }) {
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
  podeCobrar = false,
  onBaixa,
}: {
  tick?: number;
  /** Só o gestor: mostra "Dar baixa" (a API também exige admin). */
  podeDarBaixa?: boolean;
  /** Só o gestor: checkboxes + "Cobrar Selecionados" (a API também exige admin). */
  podeCobrar?: boolean;
  /** Avisa a tela de cima (resumo, cobranças) sem recarregar este painel. */
  onBaixa?: () => void;
}) {
  const [aba, setAba] = useState<Aba>("");
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [busca, setBusca] = useState("");
  const [baixas, setBaixas] = useState<Baixas>({});
  const [selecionado, setSelecionado] = useState<MensalidadePainelItem>();
  /** Aluno pendente sem cobrança no mês: modal "Gerar cobrança". */
  const [gerando, setGerando] = useState<MensalidadePainelItem>();
  const [aviso, setAviso] = useState("");
  /** Pendentes marcados para cobrança: payment_id → nome (vale entre páginas/abas). */
  const [marcados, setMarcados] = useState<Record<string, string>>({});
  const [cobrando, setCobrando] = useState(false);
  const [fila, setFila] = useState<ItemFila[]>();
  /** Último window.open() da fila voltou null (pop-up bloqueado). */
  const [bloqueado, setBloqueado] = useState(false);
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

  // Cobráveis = pendentes com cobrança gerada (sem payment_id não há o que cobrar).
  const cobraveis = podeCobrar
    ? itens.filter(
        (i): i is typeof i & { payment_id: string } => i.status === "pendente" && !!i.payment_id,
      )
    : [];
  const qtdMarcados = Object.keys(marcados).length;
  const todosVisiveisMarcados =
    cobraveis.length > 0 && cobraveis.every((i) => marcados[i.payment_id]);

  function marcar(payment_id: string, nome: string, sim: boolean) {
    setMarcados(({ [payment_id]: _, ...resto }) =>
      sim ? { ...resto, [payment_id]: nome } : resto,
    );
  }
  function marcarVisiveis(sim: boolean) {
    setMarcados((m) => {
      const novo = { ...m };
      for (const i of cobraveis)
        if (sim) novo[i.payment_id] = i.nome;
        else delete novo[i.payment_id];
      return novo;
    });
  }

  async function cobrarSelecionados() {
    const alvos = Object.entries(marcados);
    if (!alvos.length || cobrando) return;
    setCobrando(true);
    setAviso("");
    // Ainda dentro do clique: abre uma aba por aluno. O que o navegador
    // bloquear vira null e o link fica na fila para abrir com um toque.
    const abas = alvos.map(() => abrirAba());
    const respostas = await Promise.allSettled(
      alvos.map(([payment_id]) =>
        api<CobrancaWhatsApp>("/notificacoes/cobrar", { method: "POST", body: { payment_id } }),
      ),
    );
    const livres = abas.filter((w): w is Window => !!w);
    const itensFila: ItemFila[] = respostas.map((res, n) => {
      const [payment_id, nome] = alvos[n];
      if (res.status === "rejected")
        return { payment_id, nome, aberto: false, erro: errorMessage(res.reason) };
      const aba = livres.shift();
      if (aba) aba.location.href = res.value.whatsapp_url;
      return { payment_id, nome, aberto: !!aba, cobranca: res.value };
    });
    for (const sobra of livres) sobra.close(); // abas sem link (falhas)
    setFila(itensFila);
    // Nenhuma aba abriu, nem a primeira: é bloqueio de pop-up, não o limite
    // normal de uma janela por clique. Ninguém foi marcado como aberto.
    setBloqueado(itensFila.some((i) => i.cobranca) && !itensFila.some((i) => i.aberto));
    // Quem já tem link sai da seleção; quem falhou continua marcado.
    setMarcados(
      Object.fromEntries(itensFila.filter((i) => i.erro).map((i) => [i.payment_id, i.nome])),
    );
    setCobrando(false);
  }

  const marcarAberto = (payment_id: string) =>
    setFila((f) => f?.map((i) => (i.payment_id === payment_id ? { ...i, aberto: true } : i)));
  /**
   * Única porta de abertura da fila. Só marca como aberto se o navegador
   * entregou a janela; window.open() === null (pop-up bloqueado) deixa o item
   * na fila e mostra o aviso para liberar pop-ups.
   */
  function abrirNaFila(item: ItemFila) {
    if (!item.cobranca) return;
    const w = abrirAba();
    if (!w) {
      setBloqueado(true);
      return;
    }
    w.location.href = item.cobranca.whatsapp_url;
    marcarAberto(item.payment_id);
    setBloqueado(false);
  }
  const proximo = fila?.find((i) => i.cobranca && !i.aberto);

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

      {podeCobrar && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={todosVisiveisMarcados}
              disabled={!cobraveis.length}
              onChange={(e) => marcarVisiveis(e.target.checked)}
              // `!`: o CSS legado `.workspace-body input` daria padding ao checkbox
              className="size-5! shrink-0 p-0! accent-primary"
            />
            Selecionar pendentes desta página
          </label>
          <button
            type="button"
            onClick={() => void cobrarSelecionados()}
            disabled={!qtdMarcados || cobrando}
            className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-primary-strong px-5 text-sm font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {cobrando ? (
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
            ) : (
              <MessageCircle size={18} aria-hidden="true" />
            )}
            Cobrar Selecionados{qtdMarcados ? ` (${qtdMarcados})` : ""}
          </button>
        </div>
      )}

      {fila && (
        <section
          aria-labelledby="fila-titulo"
          className="mt-3 rounded-2xl border border-border-strong bg-surface-raised p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p id="fila-titulo" className="font-bold text-text-main">
                Fila de cobrança
              </p>
              <p role="status" className="mt-0.5 text-xs text-text-muted">
                {fila.filter((i) => i.aberto).length} de {fila.filter((i) => i.cobranca).length}{" "}
                aberta(s) no WhatsApp
                {fila.some((i) => i.erro) && ` · ${fila.filter((i) => i.erro).length} com erro`}
                {proximo && ". O navegador abre uma janela por clique: toque para abrir as demais."}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setFila(undefined);
                setBloqueado(false);
              }}
              aria-label="Fechar fila de cobrança"
              className="grid size-10 shrink-0 place-items-center rounded-full text-text-muted transition hover:bg-surface hover:text-text-main"
            >
              <X size={18} />
            </button>
          </div>
          {bloqueado && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm text-text-main"
            >
              O navegador bloqueou a janela do WhatsApp. Libere os pop-ups deste site (ícone na
              barra de endereço) e toque de novo em “Abrir”. Nenhuma cobrança foi marcada como
              aberta.
            </p>
          )}
          {proximo?.cobranca && (
            <button
              type="button"
              onClick={() => abrirNaFila(proximo)}
              className="mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-success/20 px-4 text-sm font-bold text-success transition hover:bg-success/30 sm:w-auto"
            >
              <ExternalLink size={16} aria-hidden="true" /> Abrir próxima: {proximo.nome}
            </button>
          )}
          <ul className="mt-3 grid gap-2">
            {fila.map((i) => (
              <li
                key={i.payment_id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border pt-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-text-main">{i.nome}</p>
                  {i.cobranca ? (
                    <p className="text-xs text-text-muted">
                      {i.cobranca.destinatario.tipo === "responsavel"
                        ? `Para o responsável ${i.cobranca.destinatario.nome}${
                            i.cobranca.menor_de_idade ? " (aluno menor de idade)" : ""
                          }`
                        : "Para o próprio aluno"}{" "}
                      · {brl(i.cobranca.valor)}
                    </p>
                  ) : (
                    <p role="alert" className="text-xs text-primary-soft">
                      {i.erro}
                    </p>
                  )}
                </div>
                {i.cobranca && (
                  // botão (não <a target=_blank>): só um window.open() diz se a janela abriu
                  <button
                    type="button"
                    onClick={() => abrirNaFila(i)}
                    aria-label={`${i.aberto ? "Abrir de novo" : "Abrir"} o WhatsApp de ${i.nome}`}
                    className="inline-flex min-h-10 items-center gap-1.5 font-bold text-success underline-offset-4 hover:underline"
                  >
                    {i.aberto ? (
                      <>
                        <CheckCircle2 size={16} aria-hidden="true" /> Aberto · abrir de novo
                      </>
                    ) : (
                      <>
                        <ExternalLink size={16} aria-hidden="true" /> Abrir WhatsApp
                      </>
                    )}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

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
          const pendente = i.status === "pendente";
          const podeBaixar = podeDarBaixa && pendente && !!i.payment_id && !!i.valor;
          // Checkbox SEMPRE presente nos pendentes (gestor); sem cobrança gerada
          // fica desabilitado até "Gerar cobrança" criar o payment_id.
          const temCobranca = !!i.payment_id;
          const podeGerar = podeDarBaixa && pendente && !temCobranca;
          return (
            <li
              key={i.user_id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-l-4 border-border px-4 py-3 transition-colors duration-500 ${
                i.status === "pago" ? "border-l-success" : "border-l-primary"
              } ${i.recemPago ? "bg-success/10" : "bg-surface-raised"}`}
            >
              {podeCobrar && pendente && (
                // área de toque de 44px em volta do checkbox de 20px
                <label
                  className={`-my-2 -ml-2 grid size-11 shrink-0 place-items-center ${
                    temCobranca ? "cursor-pointer" : "cursor-not-allowed"
                  }`}
                  title={temCobranca ? undefined : "Gere a cobrança do mês para poder cobrar."}
                >
                  <input
                    type="checkbox"
                    checked={temCobranca && !!marcados[i.payment_id!]}
                    disabled={!temCobranca}
                    onChange={(e) => marcar(i.payment_id!, i.nome, e.target.checked)}
                    aria-label={
                      temCobranca
                        ? `Selecionar ${i.nome} para cobrança`
                        : `${i.nome}: gere a cobrança do mês para poder cobrar`
                    }
                    className="size-5! p-0! accent-primary disabled:opacity-40"
                  />
                </label>
              )}
              {/* min-w-28: em telas estreitas (checkbox + selo) o selo desce de linha em vez de esmagar o nome */}
              <div className="min-w-28 flex-1">
                <p className="flex min-w-0 items-center gap-1.5 font-semibold text-text-main">
                  {/* Flag de alerta: obrigatória em TODO pendente, para qualquer papel. */}
                  {pendente && (
                    <Flag
                      data-flag="pendente"
                      size={15}
                      className="shrink-0 fill-primary-strong text-primary"
                      aria-label="Mensalidade pendente"
                      role="img"
                    />
                  )}
                  <span className="truncate" title={i.nome}>
                    {i.nome}
                  </span>
                </p>
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
              {podeGerar && (
                <button
                  type="button"
                  onClick={() => {
                    setAviso("");
                    setGerando(i);
                  }}
                  aria-label={`Gerar a cobrança do mês de ${i.nome}`}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-primary/60 px-4 text-sm font-bold text-text-main transition hover:bg-primary-strong/20 focus-visible:outline-primary sm:w-auto"
                >
                  <FilePlus2 size={16} aria-hidden="true" /> Gerar cobrança
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
            // pago não se cobra: sai da seleção
            marcar(res.mensalidade.payment_id, selecionado.nome, false);
            setSelecionado(undefined);
            onBaixa?.();
          }}
        />
      )}
      {gerando && (
        <GerarCobranca
          key={gerando.user_id}
          item={gerando}
          valorPadrao={r.data?.valor_padrao}
          onClose={() => setGerando(undefined)}
          onSucesso={(f) => {
            setAviso(
              `Cobrança gerada: ${gerando.nome}, ${brl(f.valor)} com vencimento em ${day(f.data_vencimento)}.`,
            );
            setGerando(undefined);
            r.reload(); // o cartão volta com payment_id: checkbox e "Dar baixa" liberados
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

/**
 * Gera a cobrança do mês para um aluno que aparece como pendente sem cobrança
 * (POST /mensalidades, só gestor). Valor sugerido: BILLING_AMOUNT; vencimento
 * sugerido: o previsto que o painel já mostra. Ambos editáveis.
 */
function GerarCobranca({
  item,
  valorPadrao,
  onClose,
  onSucesso,
}: {
  item: MensalidadePainelItem;
  valorPadrao?: string;
  onClose: () => void;
  onSucesso: (f: Financeiro) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [valor, setValor] = useState((valorPadrao ?? "").replace(".", ","));
  const [vencimento, setVencimento] = useState(item.data_vencimento);
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
    if (normalizado === "0.00") invalido = "O valor precisa ser maior que zero.";
  } catch (e) {
    invalido = errorMessage(e);
  }
  if (!invalido && !/^\d{4}-\d{2}-\d{2}$/.test(vencimento)) invalido = "Informe o vencimento.";

  async function gerar(e: FormEvent) {
    e.preventDefault();
    if (invalido || enviando) return;
    setEnviando(true);
    setFalha("");
    try {
      onSucesso(
        await api<Financeiro>("/mensalidades", {
          method: "POST",
          body: { user_id: item.user_id, valor: normalizado, data_vencimento: vencimento },
        }),
      );
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
      aria-labelledby="gerar-titulo"
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-border bg-surface p-0 text-text-main backdrop:bg-secondary/75 backdrop:backdrop-blur-sm sm:m-auto sm:w-[min(440px,calc(100%-2rem))] sm:rounded-3xl"
    >
      <form
        onSubmit={(e) => void gerar(e)}
        className="flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-bold tracking-[0.2em] text-text-muted uppercase">
              Cobrança do mês
            </p>
            <h2
              id="gerar-titulo"
              className="mt-1 font-display text-2xl leading-tight font-black uppercase italic"
            >
              Gerar cobrança para {item.nome}
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              Depois de gerada, dá para cobrar pelo WhatsApp e dar baixa.
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
          Valor (R$)
          <input
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            aria-invalid={!!invalido}
            aria-describedby="gerar-ajuda"
            className="h-12 rounded-xl text-lg tabular-nums"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold">
          Vencimento
          <input
            type="date"
            value={vencimento}
            onChange={(e) => setVencimento(e.target.value)}
            className="h-12 rounded-xl"
          />
        </label>
        <p
          id="gerar-ajuda"
          className={`-mt-2 text-xs ${invalido ? "text-primary-soft" : "text-text-muted"}`}
        >
          {invalido || `Será cobrado ${brl(normalizado)} com vencimento em ${day(vencimento)}.`}
        </p>

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
            <FilePlus2 size={20} aria-hidden="true" />
          )}
          Gerar cobrança
        </button>
      </form>
    </dialog>
  );
}
