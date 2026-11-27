import { lazy, Suspense, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Camera } from "lucide-react";
import { Avatar, BotaoEditarPerfil, alturaTexto, pesoTexto } from "./Perfil";

// Modal carregado só quando o aluno abre (traz o Zod e o tratamento de imagem).
const EditarPerfil = lazy(() => import("./EditarPerfil"));
import { Badge, mesAno } from "./PainelMensalidades";
import type {
  AlunoProfile,
  ImcClassificacao,
  Aluno,
  Carteirinha,
  Financeiro,
  MensalidadeAtual,
  Attendance,
  GraduacaoHistorico,
  LojaVenda,
  Paginated,
} from "../types/contract";
import { api, errorMessage, HttpError } from "../lib/api";
import {
  Card,
  Loading,
  Notice,
  Table,
  Pager,
  Status,
  useResource,
  labels,
  brl,
  day,
  time,
  graduacaoTexto,
} from "./ui";

export function Member() {
  const [revision, setRevision] = useState(0);
  const [card, setCard] = useState<Carteirinha>();
  const [cardError, setCardError] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [editando, setEditando] = useState(false);
  const [modalCarregado, setModalCarregado] = useState(false);
  const abrirEdicao = () => {
    setModalCarregado(true);
    setEditando(true);
  };
  const profile = useResource<Aluno>("/me/perfil", revision);
  const payments = useResource<Financeiro[]>("/me/mensalidades", revision);
  // Mês atual com a MESMA regra do painel do gestor (pendente até entrar no caixa).
  const atual = useResource<MensalidadeAtual | null>("/me/mensalidades/atual", revision);
  const ranks = useResource<GraduacaoHistorico[]>("/me/graduacoes", revision);
  const [page, setPage] = useState(1);
  const [purchasePage, setPurchasePage] = useState(1);
  const attendance = useResource<Paginated<Attendance>>(`/me/presencas?page=${page}`, revision);
  const purchases = useResource<Paginated<LojaVenda & { produto_nome: string }>>(
    `/me/compras?page=${purchasePage}`,
    revision,
  );
  useEffect(() => {
    const controller = new AbortController();
    let renew: ReturnType<typeof setTimeout>;
    let expire: ReturnType<typeof setTimeout>;
    let loading = false;
    async function load() {
      if (loading || controller.signal.aborted) return;
      loading = true;
      try {
        const value = await api<Carteirinha>("/me/carteirinha", { signal: controller.signal });
        if (controller.signal.aborted) return;
        setCard(value);
        setCardError("");
        setBlocked(false);
        clearTimeout(expire);
        expire = setTimeout(
          () => setCard(undefined),
          Math.max(1, Date.parse(value.qr_expires_at) - Date.now()),
        );
        renew = setTimeout(
          () => void load(),
          Math.max(1000, Date.parse(value.qr_expires_at) - Date.now() - 10000),
        );
      } catch (e) {
        if (controller.signal.aborted) return;
        setCard(undefined);
        setCardError(errorMessage(e));
        setBlocked(e instanceof HttpError && e.code === "CARTEIRINHA_BLOQUEADA");
        renew = setTimeout(() => void load(), 30000);
      } finally {
        loading = false;
      }
    }
    void load();
    const visible = () => {
      if (!document.hidden) {
        clearTimeout(renew);
        clearTimeout(expire);
        setCard(undefined);
        void load();
      }
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(renew);
      clearTimeout(expire);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [revision]);
  return (
    <>
      <Card
        title="Minha carteirinha"
        action={
          <button className="secondary" onClick={() => setRevision((v) => v + 1)}>
            Atualizar
          </button>
        }
      >
        <Loading {...profile} />
        <Notice error={cardError} />
        {profile.data && (
          <section className="member">
            <div className="member-top">
              <strong>BONSAI JIU JITSU</strong>
              <span>MEMBRO OFICIAL</span>
            </div>
            <div className="member-main">
              {/*
                Bloco único: foto + nome/lápis e, ao lado da foto, os dados
                biométricos (altura, peso e, logo abaixo, o IMC calculado pela API).
                Abaixo de 360px a biometria ocupa a largura toda, sob a foto. Até 720px o
                bloco ocupa a linha inteira (basis-full) e o QR desce: sem isso o QR
                dividia a linha e espremia o nome.
              */}
              <div className="grid min-w-0 flex-1 grid-cols-[68px_minmax(0,1fr)] items-start gap-x-4 gap-y-3 max-[720px]:basis-full">
                <button
                  type="button"
                  onClick={abrirEdicao}
                  aria-label="Trocar foto de perfil"
                  className="member-avatar relative shrink-0 overflow-hidden p-0"
                >
                  <Avatar
                    nome={profile.data.nome}
                    foto={profile.data.perfil.foto_url}
                    className="size-full"
                  />
                  <span className="absolute right-0 bottom-0 grid size-6 place-items-center rounded-tl-lg bg-primary-strong text-text-main">
                    <Camera size={13} aria-hidden="true" />
                  </span>
                </button>
                <div className="min-w-0">
                  <span>ALUNO</span>
                  <div className="flex items-center gap-3">
                    <h2 className="min-w-0 break-words">{profile.data.nome}</h2>
                    <BotaoEditarPerfil onClick={abrirEdicao} />
                  </div>
                  <p>Matrícula {profile.data.perfil.numero_matricula}</p>
                </div>
                <Biometria
                  perfil={profile.data.perfil}
                  onEditar={abrirEdicao}
                  className="col-span-2 min-[360px]:col-span-1 min-[360px]:col-start-2"
                />
              </div>
              {card && (
                <div className="member-qr">
                  <QRCodeSVG
                    value={card.qr_token}
                    size={172}
                    marginSize={3}
                    level="M"
                    title="Carteirinha temporária para leitura na recepção"
                  />
                </div>
              )}
            </div>
            <div className="member-foot">
              <div>
                <span>MODALIDADE</span>
                <strong>{labels[profile.data.perfil.modalidade]}</strong>
              </div>
              <div>
                <span>GRADUAÇÃO</span>
                <strong>{graduacaoTexto(profile.data.perfil)}</strong>
              </div>
              <div>
                <span>PRESENÇAS</span>
                <strong>{profile.data.perfil.total_presencas}</strong>
              </div>
            </div>
          </section>
        )}
        {profile.data && modalCarregado && (
          <Suspense fallback={null}>
            <EditarPerfil
              nome={profile.data.nome}
              perfil={profile.data.perfil}
              aberto={editando}
              onClose={() => setEditando(false)}
              onSaved={() => setRevision((v) => v + 1)}
            />
          </Suspense>
        )}
        {card && <p className="cell-note">QR renovado automaticamente. Apresente na recepção.</p>}
        {blocked && (
          <p>
            Regularize as mensalidades na recepção. Após a confirmação do pagamento, a carteirinha é
            liberada automaticamente. <a href="#minhas-mensalidades">Ver mensalidades</a>
          </p>
        )}
      </Card>
      <div id="minhas-mensalidades">
        <Card title="Minhas mensalidades">
          <Loading {...atual} />
          {atual.data && <MesAtual m={atual.data} />}
          <Loading {...payments} />
          {payments.data?.length === 0 ? (
            <p className="text-sm text-text-muted">
              Histórico: nenhuma cobrança lançada pela academia ainda.
            </p>
          ) : (
            <Table headers={["Vencimento", "Valor", "Status", "Pagamento"]} empty={false}>
              {payments.data?.map((p) => (
                <tr key={p.payment_id}>
                  <td>{day(p.data_vencimento)}</td>
                  <td>{brl(p.valor)}</td>
                  <td>
                    <Status value={p.status} />
                  </td>
                  <td>{p.data_pagamento ? day(p.data_pagamento) : "—"}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
      <Card title="Minhas presenças">
        <Loading {...attendance} />
        <Table headers={["Entrada", "Saída"]} empty={attendance.data?.data.length === 0}>
          {attendance.data?.data.map((a) => (
            <tr key={a.attendance_id}>
              <td>{time(a.check_in)}</td>
              <td>{a.check_out ? time(a.check_out) : "Em treino"}</td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={attendance.data?.total ?? 0} onPage={setPage} />
      </Card>
      <Card title="Minhas graduações">
        <Loading {...ranks} />
        <Table headers={["Data", "Faixa", "Grau"]} empty={ranks.data?.length === 0}>
          {ranks.data?.map((g) => (
            <tr key={g.id}>
              <td>{day(g.data_graduacao)}</td>
              <td>{g.faixa_nova}</td>
              <td>{g.graduacao_nova}</td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Minhas compras">
        <Loading {...purchases} />
        <Table
          headers={["Data", "Produto", "Quantidade", "Valor"]}
          empty={purchases.data?.data.length === 0}
        >
          {purchases.data?.data.map((p) => (
            <tr key={p.sale_id}>
              <td>{time(p.data_venda)}</td>
              <td>{p.produto_nome}</td>
              <td>{p.quantidade}</td>
              <td>{brl(p.valor_total)}</td>
            </tr>
          ))}
        </Table>
        <Pager page={purchasePage} total={purchases.data?.total ?? 0} onPage={setPurchasePage} />
      </Card>
    </>
  );
}

/** Data (fuso de São Paulo) de um timestamp ISO. */
const diaSP = (iso: string) =>
  new Date(iso).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

/**
 * Situação do mês atual, igual à linha do aluno no painel do gestor:
 * "pendente" até existir a entrada no caixa, inclusive sem cobrança lançada.
 */
function MesAtual({ m }: { m: MensalidadeAtual }) {
  const pago = m.status === "pago";
  return (
    <section
      aria-label="Mensalidade do mês atual"
      className={`mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-2xl border border-l-4 border-border bg-surface-raised px-4 py-4 ${
        pago ? "border-l-success" : "border-l-primary"
      }`}
    >
      <div className="min-w-0">
        <p className="text-[10px] font-extrabold tracking-[0.14em] text-text-muted uppercase">
          Mês atual · {mesAno(m.competencia)}
        </p>
        <p className="mt-1 text-base font-semibold text-text-main">
          {m.valor ? brl(m.valor) : "Valor a confirmar na recepção"}
        </p>
        <p className="mt-0.5 text-xs text-text-muted">
          {pago && m.pago_em ? `Pago em ${diaSP(m.pago_em)}` : `Vence em ${day(m.data_vencimento)}`}
          {!m.cobranca_gerada && " · cobrança ainda não lançada pela academia"}
        </p>
      </div>
      <Badge status={m.status} />
    </section>
  );
}

const IMC_ROTULO: Record<Exclude<ImcClassificacao, "menor_de_idade">, string> = {
  abaixo_do_peso: "Abaixo do peso",
  normal: "Peso normal",
  sobrepeso: "Sobrepeso",
  obesidade: "Obesidade",
};
// Sem alarmismo: só "normal" ganha cor de sucesso; obesidade em vermelho suave.
const IMC_COR: Record<Exclude<ImcClassificacao, "menor_de_idade">, string> = {
  abaixo_do_peso: "border-border-strong text-text-main",
  normal: "border-success/50 bg-success/15 text-success",
  sobrepeso: "border-border-strong text-text-main",
  obesidade: "border-primary/60 bg-primary-strong/15 text-primary-soft",
};
const umaCasa = (v: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Dados biométricos na carteirinha: altura, peso e, abaixo, o IMC com a faixa.
 * O IMC e a faixa vêm prontos da API (perfil.imc / perfil.imc_classificacao).
 * Usa dl/dt/dd/strong: o CSS legado de .member-main estiliza span e p.
 */
function Biometria({
  perfil,
  onEditar,
  className = "",
}: {
  perfil: AlunoProfile;
  onEditar: () => void;
  className?: string;
}) {
  const rotulo = "block text-[9px] font-extrabold tracking-[0.16em] text-text-muted uppercase";
  const valor = "block text-base font-bold leading-tight text-text-main tabular-nums";
  const c = perfil.imc_classificacao;
  return (
    <section
      aria-label="Dados biométricos"
      className={`min-w-0 rounded-xl border border-border bg-surface-raised/70 p-3 ${className}`}
    >
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
        <div>
          <dt className={rotulo}>Altura</dt>
          <dd className={valor}>{alturaTexto(perfil.altura)}</dd>
        </div>
        <div>
          <dt className={rotulo}>Peso</dt>
          <dd className={valor}>{pesoTexto(perfil.peso)}</dd>
        </div>
        <div className="col-span-2 border-t border-border pt-2">
          <dt className={rotulo}>IMC</dt>
          <dd className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className={valor}>{perfil.imc == null ? "—" : umaCasa(perfil.imc)}</strong>
            {c && c !== "menor_de_idade" && (
              <strong
                className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-bold ${IMC_COR[c]}`}
              >
                {IMC_ROTULO[c]}
              </strong>
            )}
          </dd>
          {c === "menor_de_idade" && (
            <dd className="mt-1 text-[11px] leading-snug text-text-muted">
              Menores de 18: avaliar pela curva de crescimento por idade.
            </dd>
          )}
        </div>
      </dl>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-[11px] text-text-muted">
        <strong className="font-normal">
          {perfil.medidas_atualizadas_em
            ? `Atualizado em ${day(perfil.medidas_atualizadas_em)}`
            : "Informe sua altura e seu peso."}
        </strong>
        <button
          type="button"
          onClick={onEditar}
          className="min-h-8 font-bold text-primary-soft underline-offset-4 hover:underline"
        >
          {perfil.altura == null || perfil.peso == null ? "Informar medidas" : "Atualizar"}
        </button>
      </div>
      {perfil.imc != null && c !== "menor_de_idade" && (
        <strong className="mt-1 block text-[10px] font-normal text-text-muted">
          IMC: referência OMS para adultos; não substitui avaliação profissional.
        </strong>
      )}
    </section>
  );
}
