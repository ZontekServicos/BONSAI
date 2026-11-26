/**
 * Turmas (gestor): lista, "Nova turma" e "Editar turma" (nome, horário,
 * modalidade, professor e alunos). O modal também é aberto pela chamada na
 * tela de Presença, então a edição reflete na lista de chamada na hora.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Clock, LoaderCircle, Pencil, Plus, Search, UserRound, UsersRound, X } from "lucide-react";
import type { Aluno, Modalidade, Paginated, Turma, TurmaDetalhe, User } from "../types/contract";
import { api, errorMessage } from "../lib/api";
import { Card, Loading, labels, modalities, useResource } from "./ui";

/** Linha de turma: "Seg e Qua · 19h · Jiu-Jitsu · Prof. Fulano". */
export const turmaResumo = (t: Turma) =>
  [t.horario, t.modalidade && labels[t.modalidade], t.professor_nome && `Prof. ${t.professor_nome}`]
    .filter(Boolean)
    .join(" · ");

export function Turmas() {
  const [inativas, setInativas] = useState(false);
  const [revisao, setRevisao] = useState(0);
  const [editando, setEditando] = useState<string | "nova">();
  const r = useResource<Turma[]>(`/turmas?incluir_inativas=${inativas}`, revisao);
  return (
    <Card
      title="Turmas"
      action={
        <button
          type="button"
          onClick={() => setEditando("nova")}
          className="inline-flex h-11 items-center gap-2 rounded-full bg-primary-strong px-5 text-sm font-bold text-text-main transition hover:brightness-110"
        >
          <Plus size={18} aria-hidden="true" /> Nova turma
        </button>
      }
    >
      <label className="mb-3 inline-flex min-h-11 cursor-pointer items-center gap-2.5 text-sm text-text-muted">
        <input
          type="checkbox"
          checked={inativas}
          onChange={(e) => setInativas(e.target.checked)}
          className="size-5! shrink-0 p-0! accent-primary"
        />
        Mostrar turmas desativadas
      </label>
      <Loading loading={r.loading && !r.data} error={r.error} />
      {r.data?.length === 0 && (
        <p className="py-8 text-center text-text-muted">
          Nenhuma turma ainda. Crie a primeira em “Nova turma”.
        </p>
      )}
      <ul className="grid gap-2 md:grid-cols-2">
        {r.data?.map((t) => (
          <li
            key={t.id}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface-raised px-4 py-3 ${
              t.ativa ? "" : "opacity-60"
            }`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-semibold text-text-main">
                {t.nome}
                {!t.ativa && <span className="ml-2 text-xs text-text-muted">(desativada)</span>}
              </p>
              <p className="mt-0.5 text-xs text-text-muted">
                {turmaResumo(t) || "Sem horário definido"}
              </p>
              <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-text-muted">
                <UsersRound size={14} aria-hidden="true" />
                {t.total_alunos} {t.total_alunos === 1 ? "aluno" : "alunos"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditando(t.id)}
              aria-label={`Editar a turma ${t.nome}`}
              className="inline-flex h-10 items-center gap-2 rounded-full border border-border-strong px-4 text-sm font-bold text-text-main transition hover:bg-surface"
            >
              <Pencil size={15} aria-hidden="true" /> Editar
            </button>
          </li>
        ))}
      </ul>
      {editando && (
        <TurmaModal
          key={editando}
          turmaId={editando === "nova" ? undefined : editando}
          onClose={() => setEditando(undefined)}
          onSaved={() => {
            setEditando(undefined);
            setRevisao((v) => v + 1);
          }}
        />
      )}
    </Card>
  );
}

type Campos = { nome: string; horario: string; modalidade: "" | Modalidade; professor_id: string };

/**
 * Criar (sem turmaId) ou editar uma turma. Na edição, salva os dados (PATCH) e
 * a diferença de alunos (POST dos novos, DELETE dos removidos).
 */
export function TurmaModal({
  turmaId,
  onClose,
  onSaved,
}: {
  turmaId?: string;
  onClose: () => void;
  onSaved: (t: Turma) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Só na edição: a turma com os alunos atuais.
  const [turma, setTurma] = useState<TurmaDetalhe>();
  const [erroTurma, setErroTurma] = useState("");
  useEffect(() => {
    if (!turmaId) return;
    const c = new AbortController();
    api<TurmaDetalhe>(`/turmas/${turmaId}`, { signal: c.signal })
      .then(setTurma)
      .catch((e) => !c.signal.aborted && setErroTurma(errorMessage(e)));
    return () => c.abort();
  }, [turmaId]);
  const professores = useResource<User[]>("/professores");
  const [campos, setCampos] = useState<Campos>();
  /** Selecionados: user_id → nome (mantém quem saiu da busca atual). */
  const [selecionados, setSelecionados] = useState<Record<string, string>>({});
  const [busca, setBusca] = useState("");
  const [termo, setTermo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [falha, setFalha] = useState("");
  const alunos = useResource<Paginated<Aluno>>(
    `/alunos?page_size=100&sort=nome${termo ? `&q=${encodeURIComponent(termo)}` : ""}`,
  );

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setTermo(busca.trim()), 250);
    return () => clearTimeout(t);
  }, [busca]);
  // Preenche o formulário quando a turma (edição) chega; criação começa vazia.
  useEffect(() => {
    if (campos) return;
    if (!turmaId) {
      setCampos({ nome: "", horario: "", modalidade: "", professor_id: "" });
      return;
    }
    if (!turma) return;
    setCampos({
      nome: turma.nome,
      horario: turma.horario ?? "",
      modalidade: turma.modalidade ?? "",
      professor_id: turma.professor_id ?? "",
    });
    setSelecionados(Object.fromEntries(turma.alunos.map((a) => [a.user_id, a.nome])));
  }, [turmaId, turma, campos]);

  const set = (k: keyof Campos) => (v: string) => setCampos((c) => c && { ...c, [k]: v });
  const alternar = (id: string, nome: string, sim: boolean) =>
    setSelecionados(({ [id]: _, ...resto }) => (sim ? { ...resto, [id]: nome } : resto));
  const qtd = Object.keys(selecionados).length;
  const nomeCurto = !campos || campos.nome.trim().length < 2;

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (!campos || nomeCurto || enviando) return;
    setEnviando(true);
    setFalha("");
    const dados = {
      nome: campos.nome.trim(),
      horario: campos.horario.trim() || null,
      modalidade: campos.modalidade || null,
      professor_id: campos.professor_id || null,
    };
    try {
      let salva: Turma;
      if (!turma) {
        const ids = Object.keys(selecionados);
        salva = await api<Turma>("/turmas", {
          method: "POST",
          body: { ...dados, ...(ids.length ? { alunos: ids } : {}) },
        });
      } else {
        salva = await api<Turma>(`/turmas/${turma.id}`, { method: "PATCH", body: dados });
        const antes = new Set(turma.alunos.map((a) => a.user_id));
        const novos = Object.keys(selecionados).filter((id) => !antes.has(id));
        const removidos = [...antes].filter((id) => !selecionados[id]);
        if (novos.length)
          await api(`/turmas/${turma.id}/alunos`, { method: "POST", body: { user_ids: novos } });
        for (const id of removidos)
          await api(`/turmas/${turma.id}/alunos/${id}`, { method: "DELETE" });
      }
      onSaved(salva);
    } catch (err) {
      setFalha(errorMessage(err));
      setEnviando(false);
    }
  }

  async function alternarAtiva() {
    if (!turma || enviando) return;
    setEnviando(true);
    setFalha("");
    try {
      onSaved(
        await api<Turma>(`/turmas/${turma.id}`, { method: "PATCH", body: { ativa: !turma.ativa } }),
      );
    } catch (err) {
      setFalha(errorMessage(err));
      setEnviando(false);
    }
  }

  const campo = "h-12 w-full rounded-xl";
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && !enviando && onClose()}
      aria-labelledby="turma-titulo"
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-y-auto rounded-t-3xl border border-border bg-surface p-0 text-text-main backdrop:bg-secondary/75 backdrop:backdrop-blur-sm sm:m-auto sm:w-[min(640px,calc(100%-2rem))] sm:rounded-3xl"
    >
      <form
        onSubmit={(e) => void salvar(e)}
        className="flex flex-col gap-4 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:p-7"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            id="turma-titulo"
            className="font-display text-2xl leading-tight font-black uppercase italic"
          >
            {turmaId ? "Editar turma" : "Nova turma"}
          </h2>
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

        {!campos ? (
          <Loading loading={!erroTurma} error={erroTurma} />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
                Nome da turma
                <input
                  value={campos.nome}
                  onChange={(e) => set("nome")(e.target.value)}
                  placeholder="Ex.: Iniciantes Manhã"
                  maxLength={80}
                  required
                  autoFocus
                  className={campo}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={14} aria-hidden="true" /> Horário
                </span>
                <input
                  value={campos.horario}
                  onChange={(e) => set("horario")(e.target.value)}
                  placeholder="Ex.: Seg, Qua e Sex · 19h"
                  maxLength={80}
                  className={campo}
                />
              </label>
              <label className="grid gap-1.5 text-sm font-semibold">
                Modalidade
                <select
                  value={campos.modalidade}
                  onChange={(e) => set("modalidade")(e.target.value)}
                  className={campo}
                >
                  <option value="">Qualquer modalidade</option>
                  {modalities.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold sm:col-span-2">
                <span className="inline-flex items-center gap-1.5">
                  <UserRound size={14} aria-hidden="true" /> Professor responsável
                </span>
                <select
                  value={campos.professor_id}
                  onChange={(e) => set("professor_id")(e.target.value)}
                  className={campo}
                >
                  <option value="">Sem professor definido</option>
                  {professores.data
                    ?.filter((p) => p.status !== "inativo" || p.id === campos.professor_id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                </select>
              </label>
            </div>

            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-semibold">
                Alunos da turma{" "}
                <span className="font-normal text-text-muted">({qtd} selecionados)</span>
              </legend>
              <label className="flex h-11 items-center gap-2 rounded-full border border-border-strong bg-surface-raised px-4 text-text-muted focus-within:border-primary">
                <Search size={16} aria-hidden="true" />
                <input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar aluno por nome ou e-mail"
                  aria-label="Buscar aluno para a turma"
                  className="h-full min-w-0 flex-1 rounded-none! border-0! bg-transparent! p-0! text-base text-text-main placeholder:text-text-muted focus-visible:outline-none sm:text-sm"
                />
              </label>
              <Loading loading={alunos.loading && !alunos.data} error={alunos.error} />
              <ul className="grid max-h-64 gap-1 overflow-y-auto overscroll-contain rounded-xl border border-border p-1">
                {alunos.data?.data.map((a) => (
                  <li key={a.id}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 hover:bg-surface-raised">
                      <input
                        type="checkbox"
                        checked={!!selecionados[a.id]}
                        onChange={(e) => alternar(a.id, a.nome, e.target.checked)}
                        className="size-5! shrink-0 p-0! accent-primary"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm">{a.nome}</span>
                      <span className="shrink-0 text-xs text-text-muted">
                        {labels[a.perfil.modalidade]}
                        {a.status !== "ativo" && ` · ${labels[a.status]}`}
                      </span>
                    </label>
                  </li>
                ))}
                {alunos.data?.data.length === 0 && (
                  <li className="px-3 py-4 text-center text-sm text-text-muted">
                    Nenhum aluno encontrado.
                  </li>
                )}
              </ul>
              {(alunos.data?.total ?? 0) > 100 && (
                <p className="text-xs text-text-muted">
                  Mostrando os 100 primeiros. Use a busca para achar os demais.
                </p>
              )}
            </fieldset>

            {falha && (
              <p
                role="alert"
                className="rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm"
              >
                {falha}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
              {turma ? (
                <button
                  type="button"
                  onClick={() => void alternarAtiva()}
                  disabled={enviando}
                  className="h-11 rounded-full px-4 text-sm font-bold text-text-muted transition hover:text-text-main"
                >
                  {turma.ativa ? "Desativar turma" : "Reativar turma"}
                </button>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={enviando || nomeCurto}
                className="inline-flex h-13 items-center justify-center gap-2 rounded-full bg-primary-strong px-6 text-base font-bold text-text-main transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {enviando && <LoaderCircle size={20} className="animate-spin" aria-hidden="true" />}
                {turmaId ? "Salvar turma" : "Criar turma"}
              </button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
