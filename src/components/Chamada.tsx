/**
 * Chamada por turma (tela de Presença; gestor e professor).
 *
 * 1. Escolhe a turma no topo (a última escolhida fica lembrada neste aparelho).
 * 2. A lista traz só os alunos da turma (GET /turmas/:id/chamada).
 * 3. Marca quem está presente e envia em lote (POST /turmas/:id/chamada).
 *
 * Quem já tem presença hoje nesta turma aparece marcado e travado; aluno
 * inadimplente/inativo aparece bloqueado (mesma regra da recepção). O gestor
 * edita a turma daqui mesmo ("Editar turma") e a lista recarrega na hora.
 */
import { useEffect, useState } from "react";
import { CheckCircle2, ListChecks, LoaderCircle, Pencil } from "lucide-react";
import type { ChamadaTurma, ResultadoChamada, Turma } from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { Card, Loading, labels, useResource } from "./ui";
import { TurmaModal, turmaResumo } from "./Turmas";

const CHAVE = "bonsai.chamada.turma";
const lembrada = () => {
  try {
    return localStorage.getItem(CHAVE) ?? "";
  } catch {
    return "";
  }
};

export function Chamada({
  tick = 0,
  podeEditarTurma = false,
  onRegistrada,
}: {
  tick?: number;
  /** Só o gestor edita turma (a API também exige admin). */
  podeEditarTurma?: boolean;
  /** Avisa a tela de Presença para recarregar "presentes agora" e o histórico. */
  onRegistrada?: () => void;
}) {
  const [revisao, setRevisao] = useState(0);
  const turmas = useResource<Turma[]>("/turmas", tick + revisao);
  const [turmaId, setTurmaId] = useState(lembrada);
  const [lista, setLista] = useState<ChamadaTurma>();
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  /** IDs marcados como presentes (ainda não enviados). */
  const [marcados, setMarcados] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<{ ok: string; alerta: string }>();
  const [editando, setEditando] = useState(false);

  // Turma lembrada que não existe mais (ou desativada) não fica selecionada.
  const valida = turmas.data?.some((t) => t.id === turmaId) ? turmaId : "";

  useEffect(() => {
    setMarcados([]);
    setLista(undefined);
    setErro("");
    if (!valida) return;
    const c = new AbortController();
    setCarregando(true);
    api<ChamadaTurma>(`/turmas/${valida}/chamada`, { signal: c.signal })
      .then((v) => !c.signal.aborted && setLista(v))
      .catch((e) => !c.signal.aborted && setErro(errorMessage(e)))
      .finally(() => !c.signal.aborted && setCarregando(false));
    return () => c.abort();
  }, [valida, tick, revisao]);

  function escolher(id: string) {
    setTurmaId(id);
    setResultado(undefined);
    try {
      localStorage.setItem(CHAVE, id);
    } catch {
      /* sem armazenamento: só não lembra a turma */
    }
  }

  const elegiveis = (lista?.alunos ?? []).filter((a) => !a.presente_hoje && a.status === "ativo");
  const toggle = (id: string) =>
    setMarcados((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const todosMarcados =
    elegiveis.length > 0 && elegiveis.every((a) => marcados.includes(a.user_id));

  async function registrar() {
    if (!lista || !marcados.length || enviando) return;
    setEnviando(true);
    setResultado(undefined);
    setErro("");
    try {
      const r = await api<ResultadoChamada>(`/turmas/${lista.turma.id}/chamada`, {
        method: "POST",
        body: { presentes: marcados },
      });
      const nome = (id: string) => lista.alunos.find((a) => a.user_id === id)?.nome ?? id;
      const juntar = (v: (string | 0)[]) => v.filter(Boolean).join(" · ");
      setResultado({
        ok: juntar([
          r.registrados.length && `${r.registrados.length} presença(s) registrada(s)`,
          r.vinculados.length && `${r.vinculados.length} check-in de hoje vinculado(s) à turma`,
          r.ja_presentes.length && `${r.ja_presentes.length} já estava(m) presente(s)`,
        ]),
        alerta: juntar([
          r.bloqueados.length &&
            `Não registrado(s), bloqueado(s): ${r.bloqueados.map((b) => `${nome(b.user_id)} (${labels[b.status]})`).join(", ")}`,
          r.em_outra_turma.length &&
            `Não registrado(s), ainda em outra turma (faça o check-out antes): ${r.em_outra_turma.map(nome).join(", ")}`,
        ]),
      });
      setMarcados([]);
      setRevisao((v) => v + 1);
      onRegistrada?.();
    } catch (e) {
      setErro(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Card title="Chamada por turma">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="grid flex-1 gap-1.5 text-sm font-semibold">
          Turma
          <select
            value={valida}
            onChange={(e) => escolher(e.target.value)}
            disabled={!turmas.data?.length}
            className="h-12 w-full rounded-xl"
          >
            <option value="">
              {turmas.data?.length ? "Escolha a turma" : "Nenhuma turma cadastrada"}
            </option>
            {turmas.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
                {t.horario ? ` · ${t.horario}` : ""}
              </option>
            ))}
          </select>
        </label>
        {podeEditarTurma && lista && (
          <button
            type="button"
            onClick={() => setEditando(true)}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-border-strong px-5 text-sm font-bold text-text-main transition hover:bg-surface-raised"
          >
            <Pencil size={16} aria-hidden="true" /> Editar turma
          </button>
        )}
      </div>
      <Loading loading={turmas.loading && !turmas.data} error={turmas.error} />
      {turmas.data?.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">
          {podeEditarTurma
            ? "Crie as turmas no menu “Turmas” para fazer a chamada por aqui."
            : "Peça ao gestor para cadastrar as turmas."}
        </p>
      )}

      {lista && (
        <p className="mt-3 text-xs text-text-muted">
          {turmaResumo(lista.turma) || "Sem horário definido"} · chamada de{" "}
          {lista.data.split("-").reverse().join("/")}
        </p>
      )}
      <Loading loading={carregando && !lista} error={erro} />
      {resultado?.ok && (
        <p role="status" className="mt-3 text-sm text-success">
          {resultado.ok}
        </p>
      )}
      {resultado?.alerta && (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm text-text-main"
        >
          {resultado.alerta}
        </p>
      )}

      {lista && lista.alunos.length === 0 && (
        <p className="py-6 text-center text-text-muted">
          Esta turma ainda não tem alunos.
          {podeEditarTurma && " Use “Editar turma” para incluir."}
        </p>
      )}
      {lista && lista.alunos.length > 0 && (
        <>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={todosMarcados}
                disabled={!elegiveis.length}
                onChange={(e) =>
                  setMarcados(e.target.checked ? elegiveis.map((a) => a.user_id) : [])
                }
                className="size-5! shrink-0 p-0! accent-primary"
              />
              Marcar todos
            </label>
            <span className="text-xs text-text-muted">
              {lista.alunos.filter((a) => a.presente_hoje).length} de {lista.alunos.length}{" "}
              presentes hoje
            </span>
          </div>
          <ul className="mt-2 grid gap-2">
            {lista.alunos.map((a) => {
              const bloqueado = a.status !== "ativo";
              const travado = a.presente_hoje || bloqueado;
              const marcado = a.presente_hoje || marcados.includes(a.user_id);
              return (
                <li key={a.user_id}>
                  <label
                    className={`flex min-h-14 items-center gap-3 rounded-2xl border border-l-4 border-border px-4 py-2 transition-colors ${
                      a.presente_hoje
                        ? "border-l-success bg-success/10"
                        : marcado
                          ? "border-l-success bg-surface-raised"
                          : bloqueado
                            ? "border-l-border bg-surface-raised opacity-60"
                            : "border-l-primary bg-surface-raised"
                    } ${travado ? "cursor-default" : "cursor-pointer"}`}
                  >
                    <input
                      type="checkbox"
                      value={a.user_id}
                      checked={marcado}
                      disabled={travado}
                      onChange={() => toggle(a.user_id)}
                      aria-label={`${a.nome}: ${a.presente_hoje ? "presente hoje" : bloqueado ? `bloqueado (${labels[a.status]})` : "marcar presença"}`}
                      className="size-5! shrink-0 p-0! accent-success"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-text-main">{a.nome}</span>
                      <span className="block text-xs text-text-muted">
                        {labels[a.modalidade]} · {a.faixa}
                      </span>
                    </span>
                    {a.presente_hoje ? (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-success">
                        <CheckCircle2 size={14} aria-hidden="true" /> Presente
                      </span>
                    ) : bloqueado ? (
                      <span className="shrink-0 text-xs font-bold text-primary-soft">
                        Bloqueado · {labels[a.status]}
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => void registrar()}
            disabled={!marcados.length || enviando}
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-primary-strong px-6 text-sm font-bold text-text-main transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            {enviando ? (
              <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />
            ) : (
              <ListChecks size={18} aria-hidden="true" />
            )}
            Registrar presença{marcados.length ? ` (${marcados.length})` : ""}
          </button>
        </>
      )}

      {editando && lista && (
        <TurmaModal
          turmaId={lista.turma.id}
          onClose={() => setEditando(false)}
          onSaved={(t) => {
            setEditando(false);
            if (!t.ativa) escolher("");
            setRevisao((v) => v + 1); // turmas e lista de chamada recarregam
          }}
        />
      )}
    </Card>
  );
}
