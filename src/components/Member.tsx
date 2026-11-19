import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
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
              <div className="member-avatar">{profile.data.nome[0]}</div>
              <div>
                <span>ALUNO</span>
                <h2>{profile.data.nome}</h2>
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
