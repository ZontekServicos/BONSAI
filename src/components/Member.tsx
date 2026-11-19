import { lazy, Suspense, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Camera } from "lucide-react";
import { Avatar, BotaoEditarPerfil, alturaTexto, pesoTexto } from "./Perfil";

// Modal carregado só quando o aluno abre (traz o Zod e o tratamento de imagem).
const EditarPerfil = lazy(() => import("./EditarPerfil"));
import type {
  Aluno,
  Carteirinha,
  Financeiro,
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
                <strong>
                  {graduacaoTexto(profile.data.perfil)}
                </strong>
              </div>
              <div>
                <span>PRESENÇAS</span>
                <strong>{profile.data.perfil.total_presencas}</strong>
              </div>
            </div>
          </section>
        )}
        {profile.data && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-2xl border border-border bg-surface-raised px-5 py-4">
            <div>
              <small className="block text-[10px] font-extrabold tracking-[0.14em] text-text-muted">
                ALTURA
              </small>
              <strong className="text-lg">{alturaTexto(profile.data.perfil.altura)}</strong>
            </div>
            <div>
              <small className="block text-[10px] font-extrabold tracking-[0.14em] text-text-muted">
                PESO
              </small>
              <strong className="text-lg">{pesoTexto(profile.data.perfil.peso)}</strong>
            </div>
            <small className="text-xs text-text-muted">
              {profile.data.perfil.medidas_atualizadas_em
                ? `Atualizado em ${day(profile.data.perfil.medidas_atualizadas_em)}`
                : "Informe sua altura e seu peso."}
            </small>
            <button className="secondary ml-auto" type="button" onClick={abrirEdicao}>
              Editar perfil
            </button>
          </div>
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
          <Loading {...payments} />
          <Table
            headers={["Vencimento", "Valor", "Status", "Pagamento"]}
            empty={payments.data?.length === 0}
          >
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
