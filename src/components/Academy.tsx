import { useEffect, useState } from "react";
import type {
  Aluno,
  Paginated,
  PresenteAgora,
  InventoryProduct,
  GraduacaoHistorico,
  Attendance,
  AlunoProfile,
  Modalidade,
  Convite,
  ConviteCriado,
} from "../types/contract";
import { MODALIDADE_COM_FAIXA } from "../types/contract";
import { Avatar, alturaTexto, pesoTexto } from "./Perfil";
import { Chamada } from "./Chamada";
import { BotaoScanner } from "./Scanner";
import { api, errorMessage } from "../lib/api";
import {
  Card,
  Form,
  Loading,
  Notice,
  Table,
  Pager,
  Status,
  useResource,
  labels,
  modalities,
  brl,
  time,
  day,
  today,
  niveis,
  graduacaoTexto,
  type Field,
} from "./ui";

/** Jiu-Jitsu: faixa + grau. Boxe, Muay Thai e MMA: nível técnico. */
function camposGraduacao(modalidade: Modalidade, atual?: AlunoProfile): Field[] {
  const mesma = atual?.modalidade === modalidade;
  return modalidade === MODALIDADE_COM_FAIXA
    ? [
        { name: "faixa", label: "Faixa", value: mesma ? atual.faixa : "Faixa branca" },
        {
          name: "grau",
          label: "Grau",
          type: "number",
          value: mesma ? atual.graduacao_nivel : 0,
          min: 0,
          max: 20,
        },
      ]
    : [
        {
          name: "nivel",
          label: "Nível",
          options: niveis,
          value: (mesma && atual.nivel) || "iniciante",
        },
      ];
}
const graduacaoBody = (modalidade: Modalidade, b: Record<string, string>) =>
  modalidade === MODALIDADE_COM_FAIXA
    ? { faixa: b.faixa, grau: Number(b.grau) }
    : { nivel: b.nivel };

/** Seletor controlado: a modalidade decide quais campos de graduação aparecem. */
function ModalidadeSelect({
  value,
  onChange,
}: {
  value: Modalidade;
  onChange: (m: Modalidade) => void;
}) {
  return (
    <div className="data-form">
      <div className="modal-fields">
        <label>
          Modalidade
          <select value={value} onChange={(e) => onChange(e.target.value as Modalidade)}>
            {modalities.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

/** Convite por link: o aluno preenche a própria ficha em /cadastro?token=…. */
function Convites({ onClose }: { onClose: () => void }) {
  const [criado, setCriado] = useState<ConviteCriado>();
  const [copiado, setCopiado] = useState(false);
  const [page, setPage] = useState(1);
  const lista = useResource<Paginated<Convite>>(`/convites?page=${page}`);
  async function copiar(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiado(true);
    } catch {
      // Sem permissão de área de transferência: o campo fica selecionado para Ctrl+C.
      (document.getElementById("convite-url") as HTMLInputElement | null)?.select();
    }
  }
  return (
    <Card
      title="Convidar aluno"
      action={
        <button className="secondary" onClick={onClose}>
          Fechar
        </button>
      }
    >
      <p>
        O aluno recebe um link de uso único, válido por 7 dias, e preenche a ficha completa (dados,
        saúde, responsável se for menor e termo). A conta é criada com o e-mail convidado.
      </p>
      <Form
        fields={[
          { name: "email", label: "E-mail do aluno", type: "email" },
          {
            name: "whatsapp",
            label: "WhatsApp (opcional, para enviar o link)",
            type: "tel",
            required: false,
          },
        ]}
        submit="Gerar link de convite"
        onSubmit={async (b) => {
          const c = await api<ConviteCriado>("/convites", {
            method: "POST",
            body: { email: b.email, whatsapp: b.whatsapp || null },
          });
          setCriado(c);
          setCopiado(false);
          lista.reload();
        }}
      />
      {criado && (
        <div className="data-form">
          <div className="modal-fields">
            <label className="full">
              Link para {criado.email_destinatario} · válido até {day(criado.data_expiracao)}
              <input
                id="convite-url"
                readOnly
                value={criado.url}
                onFocus={(e) => e.target.select()}
              />
            </label>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="primary" type="button" onClick={() => void copiar(criado.url)}>
              {copiado ? "Link copiado" : "Copiar link de convite"}
            </button>
            {criado.whatsapp_url && (
              <a className="secondary" href={criado.whatsapp_url} target="_blank" rel="noreferrer">
                Enviar pelo WhatsApp
              </a>
            )}
          </div>
          <small>O link aparece só agora. Se perder, gere outro: o anterior é cancelado.</small>
        </div>
      )}
      <Loading {...lista} />
      <Table
        headers={["E-mail", "Status", "Validade", "Enviado por", ""]}
        empty={lista.data?.data.length === 0}
      >
        {lista.data?.data.map((c) => (
          <tr key={c.id}>
            <td>{c.email_destinatario}</td>
            <td>
              <Status value={c.status} />
            </td>
            <td>{day(c.data_expiracao)}</td>
            <td>{c.criado_por_nome}</td>
            <td>
              {(c.status === "pendente" || c.status === "expirado") && (
                <button
                  className="secondary"
                  onClick={async () => {
                    await api(`/convites/${c.id}`, { method: "DELETE" });
                    lista.reload();
                  }}
                >
                  Revogar
                </button>
              )}
            </td>
          </tr>
        ))}
      </Table>
      <Pager page={page} total={lista.data?.total ?? 0} onPage={setPage} />
    </Card>
  );
}

function NewStudent({ onDone }: { onDone: () => void }) {
  const [modalidade, setModalidade] = useState<Modalidade>(MODALIDADE_COM_FAIXA);
  return (
    <Card title="Novo aluno">
      <ModalidadeSelect value={modalidade} onChange={setModalidade} />
      <Form
        fields={[
          { name: "nome", label: "Nome completo" },
          { name: "email", label: "E-mail", type: "email" },
          { name: "senha_inicial", label: "Senha inicial", type: "password" },
          ...camposGraduacao(modalidade),
          { name: "data_matricula", label: "Data de matrícula", type: "date", value: today() },
          { name: "emergencia_nome", label: "Contato de emergência" },
          { name: "emergencia_parentesco", label: "Parentesco" },
          { name: "emergencia_telefone", label: "Telefone 1 (com DDD)", type: "tel" },
          {
            name: "emergencia_telefone2",
            label: "Telefone 2 (opcional)",
            type: "tel",
            required: false,
          },
        ]}
        submit="Cadastrar aluno"
        onSubmit={async (b) => {
          await api("/alunos", {
            method: "POST",
            body: {
              nome: b.nome,
              email: b.email,
              senha_inicial: b.senha_inicial,
              modalidade,
              ...graduacaoBody(modalidade, b),
              data_matricula: b.data_matricula,
              contato_emergencia: {
                nome: b.emergencia_nome,
                parentesco: b.emergencia_parentesco,
                telefone: b.emergencia_telefone,
                telefone2: b.emergencia_telefone2 || null,
              },
            },
          });
          onDone();
        }}
      />
    </Card>
  );
}

function EditStudent({ a, onSaved }: { a: Aluno; onSaved: () => void }) {
  const [modalidade, setModalidade] = useState<Modalidade>(a.perfil.modalidade);
  const trocou = modalidade !== a.perfil.modalidade;
  return (
    <>
      <ModalidadeSelect value={modalidade} onChange={setModalidade} />
      <Form
        fields={[
          { name: "nome", label: "Nome", value: a.nome },
          { name: "email", label: "E-mail", type: "email", value: a.email },
          // Trocar a modalidade exige a graduação correspondente.
          ...(trocou ? camposGraduacao(modalidade) : []),
        ]}
        onSubmit={async (b) => {
          await api(`/alunos/${a.id}`, {
            method: "PATCH",
            body: {
              nome: b.nome,
              email: b.email,
              ...(trocou ? { modalidade, ...graduacaoBody(modalidade, b) } : {}),
            },
          });
          onSaved();
        }}
      />
    </>
  );
}

type DashboardData = {
  alunos_ativos: number;
  inadimplentes: number;
  presentes_agora: number;
  receita_mes: string;
  saldo_hoje: string;
  estoque_baixo: InventoryProduct[];
};
export function Dashboard({ tick }: { tick: number }) {
  const r = useResource<DashboardData>("/dashboard", tick);
  return (
    <>
      <Loading {...r} />
      {r.data && (
        <>
          <div className="metrics">
            {[
              ["Alunos matriculados", r.data.alunos_ativos],
              ["Presentes agora", r.data.presentes_agora],
              ["Inadimplentes", r.data.inadimplentes],
              ["Receita do mês", brl(r.data.receita_mes)],
              ["Saldo de hoje", brl(r.data.saldo_hoje)],
            ].map(([label, v]) => (
              <section className="metric" key={label}>
                <span>{label}</span>
                <strong>{v}</strong>
              </section>
            ))}
          </div>
          <Card title="Estoque baixo">
            <Table
              headers={["Produto", "Categoria", "Disponível"]}
              empty={!r.data.estoque_baixo.length}
            >
              {r.data.estoque_baixo.map((p) => (
                <tr key={p.product_id}>
                  <td>{p.nome}</td>
                  <td>{p.categoria}</td>
                  <td>{p.estoque_atual}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
export function StudentPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const r = useResource<Paginated<Aluno>>(
    `/alunos?page_size=20${search ? `&q=${encodeURIComponent(search)}` : ""}`,
  );
  useEffect(() => {
    const t = setTimeout(() => setSearch(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="student-picker">
      <label>
        Buscar aluno
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome ou e-mail" />
      </label>
      <label>
        Aluno selecionado
        <select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Selecione um aluno</option>
          {value && !r.data?.data.some((a) => a.id === value) && (
            <option value={value}>Aluno selecionado</option>
          )}
          {r.data?.data.map((a) => (
            <option key={a.id} value={a.id}>
              {a.nome} · {a.email}
            </option>
          ))}
        </select>
      </label>
      <Loading {...r} />
    </div>
  );
}
/** canManage=false (professor): sem cadastro simples, edição de dados e status da matrícula. */
export function Students({ canManage = true }: { canManage?: boolean }) {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [inviting, setInviting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const r = useResource<Paginated<Aluno>>(
    `/alunos?page=${page}${search ? `&q=${encodeURIComponent(search)}` : ""}`,
  );
  if (selected)
    return (
      <StudentDetail
        id={selected}
        canManage={canManage}
        onBack={() => {
          setSelected(undefined);
          r.reload();
        }}
      />
    );
  return (
    <>
      <Card
        title="Base de alunos"
        action={
          <div className="flex flex-wrap gap-2">
            <button className="secondary" onClick={() => setInviting(!inviting)}>
              {inviting ? "Fechar convites" : "Convidar aluno"}
            </button>
            {canManage && (
              <button className="primary" onClick={() => setAdding(!adding)}>
                {adding ? "Fechar cadastro" : "Novo aluno"}
              </button>
            )}
          </div>
        }
      >
        <label className="search">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar nome ou e-mail"
            aria-label="Buscar aluno"
          />
        </label>
        <Loading {...r} />
        <Table
          headers={["Aluno", "Modalidade", "Graduação", "Status", "Perfil"]}
          empty={r.data?.data.length === 0}
        >
          {r.data?.data.map((a) => (
            <tr key={a.id}>
              <td>
                <strong>{a.nome}</strong>
                <small className="cell-note">{a.email}</small>
              </td>
              <td>{labels[a.perfil.modalidade]}</td>
              <td>{graduacaoTexto(a.perfil)}</td>
              <td>
                <Status value={a.status} />
              </td>
              <td>
                <button className="secondary" onClick={() => setSelected(a.id)}>
                  Abrir
                </button>
              </td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={r.data?.total ?? 0} onPage={setPage} />
      </Card>
      {inviting && <Convites onClose={() => setInviting(false)} />}
      {canManage && adding && (
        <NewStudent
          onDone={() => {
            setAdding(false);
            r.reload();
          }}
        />
      )}
    </>
  );
}
function StudentDetail({
  id,
  canManage,
  onBack,
}: {
  id: string;
  canManage: boolean;
  onBack: () => void;
}) {
  const r = useResource<Aluno>(`/alunos/${id}`);
  const h = useResource<GraduacaoHistorico[]>(`/alunos/${id}/graduacoes`);
  const a = r.data;
  return (
    <>
      <button className="secondary" onClick={onBack}>
        Voltar para alunos
      </button>
      <Loading {...r} />
      {a && (
        <>
          <Card title={a.nome}>
            <div className="flex items-center gap-4">
              <Avatar
                nome={a.nome}
                foto={a.perfil.foto_url}
                className="size-16 shrink-0 rounded-2xl border border-border-strong bg-surface-raised text-2xl font-black text-primary-soft"
              />
              <div>
                <Status value={a.status} />
                <p>
                  {a.perfil.total_presencas} presenças · Matrícula {a.perfil.numero_matricula}
                </p>
                <p className="cell-note">
                  Altura {alturaTexto(a.perfil.altura)} · Peso {pesoTexto(a.perfil.peso)}
                  {a.perfil.medidas_atualizadas_em &&
                    ` · informado em ${day(a.perfil.medidas_atualizadas_em)}`}
                </p>
              </div>
            </div>
            {canManage && <EditStudent key={JSON.stringify(a)} a={a} onSaved={r.reload} />}
          </Card>
          {canManage && (
            <Card title="Status da matrícula">
              <p>
                A inadimplência é calculada pelas mensalidades. Inativar revoga o acesso do aluno.
              </p>
              <Form
                fields={[
                  {
                    name: "status",
                    label: "Status administrativo",
                    value: a.status === "inativo" ? "inativo" : "ativo",
                    options: [
                      { value: "ativo", label: "Ativo (sujeito à situação financeira)" },
                      { value: "inativo", label: "Inativo" },
                    ],
                  },
                ]}
                onSubmit={async (b) => {
                  await api(`/alunos/${id}/status`, { method: "PATCH", body: b });
                  r.reload();
                }}
              />
            </Card>
          )}
          <Card title="Registrar graduação">
            <Form
              key={a.perfil.modalidade}
              fields={[
                ...(a.perfil.modalidade === MODALIDADE_COM_FAIXA
                  ? [
                      { name: "faixa_nova", label: "Nova faixa", value: a.perfil.faixa },
                      {
                        name: "graduacao_nova",
                        label: "Novo grau",
                        type: "number",
                        min: 0,
                        max: 20,
                        value: a.perfil.graduacao_nivel,
                      },
                    ]
                  : [
                      {
                        name: "nivel_novo",
                        label: "Novo nível",
                        options: niveis,
                        value: a.perfil.nivel ?? "iniciante",
                      },
                    ]),
                { name: "data_graduacao", label: "Data", type: "date", value: today() },
                { name: "observacao", label: "Observação", required: false },
              ]}
              onSubmit={async (b) => {
                await api(`/alunos/${id}/graduacoes`, {
                  method: "POST",
                  body: {
                    ...b,
                    ...(b.graduacao_nova !== undefined
                      ? { graduacao_nova: Number(b.graduacao_nova) }
                      : {}),
                    observacao: b.observacao || undefined,
                  },
                });
                r.reload();
                h.reload();
              }}
            />
            <Loading {...h} />
            <Table headers={["Data", "Faixa / nível", "Grau"]} empty={h.data?.length === 0}>
              {h.data?.map((g) => (
                <tr key={g.id}>
                  <td>{day(g.data_graduacao)}</td>
                  <td>{g.faixa_nova}</td>
                  <td>{g.modalidade === MODALIDADE_COM_FAIXA ? g.graduacao_nova : "—"}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
export function Presence({
  tick,
  podeEditarTurma = false,
}: {
  tick: number;
  /** Gestor: edita a turma direto da chamada. */
  podeEditarTurma?: boolean;
}) {
  const r = useResource<PresenteAgora[]>("/presencas/ativas", tick);
  const [id, setId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [page, setPage] = useState(1);
  const h = useResource<Paginated<Attendance & { nome: string }>>(`/presencas?page=${page}`, tick);
  async function checkout(attendance_id: string) {
    if (busy) return;
    setBusy(attendance_id);
    setError("");
    try {
      await api(`/presencas/${attendance_id}/check-out`, { method: "PATCH" });
      r.reload();
      h.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Chamada
        tick={tick}
        podeEditarTurma={podeEditarTurma}
        onRegistrada={() => {
          r.reload();
          h.reload();
        }}
      />
      <Card title="Registrar entrada">
        {/* Câmera: lê o QR da carteirinha e registra a entrada na hora. */}
        <div className="mb-5 border-b border-border pb-5">
          <BotaoScanner
            onCheckIn={() => {
              r.reload();
              h.reload();
            }}
          />
        </div>
        <StudentPicker value={id} onChange={setId} />
        <Form
          fields={[]}
          submit="Confirmar entrada do aluno"
          onSubmit={async () => {
            if (!id) throw new Error("Selecione um aluno.");
            await api("/presencas/check-in", { method: "POST", body: { user_id: id } });
            r.reload();
            h.reload();
          }}
        />
        <details>
          <summary>Validar QR da carteirinha</summary>
          <Form
            fields={[{ name: "qr_token", label: "Conteúdo do QR (leitor da recepção)" }]}
            submit="Validar e registrar entrada"
            onSubmit={async (b) => {
              const v = await api<{ liberado: boolean; motivo?: string }>("/carteirinha/validar", {
                method: "POST",
                body: { ...b, registrar_checkin: true },
              });
              if (!v.liberado)
                throw new Error(
                  v.motivo === "ALUNO_INATIVO"
                    ? "Aluno inativo."
                    : "Carteirinha bloqueada por inadimplência.",
                );
              r.reload();
              h.reload();
            }}
          />
        </details>
      </Card>
      <Card
        title="Presentes agora"
        action={
          <button className="secondary" onClick={r.reload}>
            Atualizar
          </button>
        }
      >
        <Loading {...r} />
        <Notice error={error} />
        <Table headers={["Aluno", "Modalidade", "Entrada", "Saída"]} empty={r.data?.length === 0}>
          {r.data?.map((a) => (
            <tr key={a.attendance_id}>
              <td>{a.nome}</td>
              <td>{labels[a.modalidade]}</td>
              <td>{time(a.check_in)}</td>
              <td>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => void checkout(a.attendance_id)}
                >
                  {busy === a.attendance_id ? "Registrando…" : "Registrar saída"}
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Histórico de presenças">
        <Loading {...h} />
        <Table headers={["Aluno", "Entrada", "Saída"]} empty={h.data?.data.length === 0}>
          {h.data?.data.map((a) => (
            <tr key={a.attendance_id}>
              <td>{a.nome}</td>
              <td>{time(a.check_in)}</td>
              <td>{a.check_out ? time(a.check_out) : "Em treino"}</td>
            </tr>
          ))}
        </Table>
        <Pager page={page} total={h.data?.total ?? 0} onPage={setPage} />
      </Card>
    </>
  );
}
