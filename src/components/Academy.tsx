import { useEffect, useState } from "react";
import type {
  Aluno,
  Paginated,
  PresenteAgora,
  InventoryProduct,
  GraduacaoHistorico,
  Attendance,
} from "../types/contract";
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
} from "./ui";

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
export function Students() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string>();
  const [adding, setAdding] = useState(false);
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
          <button className="primary" onClick={() => setAdding(!adding)}>
            {adding ? "Fechar cadastro" : "Novo aluno"}
          </button>
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
              <td>
                {a.perfil.faixa} · {a.perfil.graduacao_nivel}º grau
              </td>
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
      {adding && (
        <Card title="Novo aluno">
          <Form
            fields={[
              { name: "nome", label: "Nome completo" },
              { name: "email", label: "E-mail", type: "email" },
              { name: "senha_inicial", label: "Senha inicial", type: "password" },
              { name: "modalidade", label: "Modalidade", options: modalities },
              { name: "faixa", label: "Faixa / graduação", value: "Faixa branca" },
              { name: "graduacao_nivel", label: "Grau", type: "number", value: 0, min: 0, max: 20 },
              { name: "data_matricula", label: "Data de matrícula", type: "date", value: today() },
            ]}
            submit="Cadastrar aluno"
            onSubmit={async (b) => {
              await api("/alunos", {
                method: "POST",
                body: { ...b, graduacao_nivel: Number(b.graduacao_nivel) },
              });
              setAdding(false);
              r.reload();
            }}
          />
        </Card>
      )}
    </>
  );
}
function StudentDetail({ id, onBack }: { id: string; onBack: () => void }) {
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
            <Status value={a.status} />
            <p>
              {a.perfil.total_presencas} presenças · Matrícula {a.perfil.numero_matricula}
            </p>
            <Form
              key={JSON.stringify(a)}
              fields={[
                { name: "nome", label: "Nome", value: a.nome },
                { name: "email", label: "E-mail", type: "email", value: a.email },
                {
                  name: "modalidade",
                  label: "Modalidade",
                  options: modalities,
                  value: a.perfil.modalidade,
                },
              ]}
              onSubmit={async (b) => {
                await api(`/alunos/${id}`, { method: "PATCH", body: b });
                r.reload();
              }}
            />
          </Card>
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
          <Card title="Registrar graduação">
            <Form
              fields={[
                { name: "faixa_nova", label: "Nova faixa", value: a.perfil.faixa },
                {
                  name: "graduacao_nova",
                  label: "Novo grau",
                  type: "number",
                  min: 0,
                  max: 20,
                  value: a.perfil.graduacao_nivel,
                },
                { name: "data_graduacao", label: "Data", type: "date", value: today() },
                { name: "observacao", label: "Observação", required: false },
              ]}
              onSubmit={async (b) => {
                await api(`/alunos/${id}/graduacoes`, {
                  method: "POST",
                  body: {
                    ...b,
                    graduacao_nova: Number(b.graduacao_nova),
                    observacao: b.observacao || undefined,
                  },
                });
                r.reload();
                h.reload();
              }}
            />
            <Loading {...h} />
            <Table headers={["Data", "Faixa", "Grau"]} empty={h.data?.length === 0}>
              {h.data?.map((g) => (
                <tr key={g.id}>
                  <td>{day(g.data_graduacao)}</td>
                  <td>{g.faixa_nova}</td>
                  <td>{g.graduacao_nova}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
export function Presence({ tick }: { tick: number }) {
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
      <Card title="Registrar entrada">
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
