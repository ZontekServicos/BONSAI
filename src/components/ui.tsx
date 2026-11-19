import { useEffect, useState, type ReactNode, type FormEvent } from "react";
import { api, errorMessage } from "../lib/api";
import {
  MODALIDADES,
  METODOS_PAGAMENTO,
  MODALIDADE_COM_FAIXA,
  NIVEIS_TECNICOS,
  NIVEL_ROTULO,
  type AlunoProfile,
} from "../types/contract";

export const labels: Record<string, string> = {
  jiu_jitsu: "Jiu-Jitsu",
  boxe: "Boxe",
  muay_thai: "Muay Thai",
  mma: "MMA",
  ativo: "Ativo",
  inativo: "Inativo",
  inadimplente: "Inadimplente",
  pago: "Pago",
  pendente: "Pendente",
  atrasado: "Atrasado",
  expirado: "Expirado",
  utilizado: "Utilizado",
  revogado: "Revogado",
  pix: "Pix",
  dinheiro: "Dinheiro",
  cartao_credito: "Cartão de crédito",
  cartao_debito: "Cartão de débito",
  boleto: "Boleto",
  transferencia: "Transferência",
  entrada: "Entrada",
  saida: "Saída",
};
export const modalities = MODALIDADES.map((value) => ({ value, label: labels[value] }));
export const niveis = NIVEIS_TECNICOS.map((value) => ({ value, label: NIVEL_ROTULO[value] }));
/** Jiu-Jitsu: "Azul · 2º grau". Demais modalidades: só o nível ("Intermediário"). */
export const graduacaoTexto = (p: Pick<AlunoProfile, "modalidade" | "faixa" | "graduacao_nivel">) =>
  p.modalidade === MODALIDADE_COM_FAIXA ? `${p.faixa} · ${p.graduacao_nivel}º grau` : p.faixa;
export const methods = METODOS_PAGAMENTO.map((value) => ({ value, label: labels[value] }));
export const brl = (v: string) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(v));
export const day = (v: string) => v.slice(0, 10).split("-").reverse().join("/");
export const time = (v: string) =>
  new Date(v).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export function useResource<T>(path: string, tick = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<T>(path, { signal: controller.signal })
      .then((v) => {
        if (!controller.signal.aborted) setData(v);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, tick, revision]);
  return { data, error, loading, reload: () => setRevision((n) => n + 1) };
}
export function Notice({ error }: { error: string }) {
  return error ? (
    <p className="error notice" role="alert">
      {error}
    </p>
  ) : null;
}
export function Status({ value }: { value: string }) {
  return (
    <span
      className={`status ${value === "ativo" || value === "pago" || value === "utilizado" ? "active" : ""}`}
    >
      {labels[value] ?? value}
    </span>
  );
}
export function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="card workspace-card">
      <div className="card-head">
        <h2>{title}</h2>
        {action}
      </div>
      <div className="workspace-body">{children}</div>
    </section>
  );
}
export function Table({
  headers,
  children,
  empty,
}: {
  headers: string[];
  children: ReactNode;
  empty?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {empty && <div className="empty">Nenhum registro encontrado.</div>}
    </div>
  );
}
export function Pager({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (v: number) => void;
}) {
  return (
    <div className="pager">
      <button className="secondary" disabled={page === 1} onClick={() => onPage(page - 1)}>
        Anterior
      </button>
      <span>
        Página {page} · {total} registros
      </span>
      <button className="secondary" disabled={page * 20 >= total} onClick={() => onPage(page + 1)}>
        Próxima
      </button>
    </div>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  value?: string | number;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: string;
  required?: boolean;
  hint?: string;
};
export function Form({
  fields,
  onSubmit,
  submit = "Salvar",
}: {
  fields: Field[];
  onSubmit: (data: Record<string, string>) => Promise<unknown>;
  submit?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      await onSubmit(data);
      setSuccess("Operação concluída.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="data-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="modal-fields">
          {fields.map((f) => (
            <label key={f.name}>
              {f.label}
              {f.options ? (
                <select name={f.name} defaultValue={f.value} required={f.required !== false}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={f.name}
                  type={f.type ?? "text"}
                  defaultValue={f.value}
                  required={f.required !== false}
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  minLength={f.type === "password" ? 8 : undefined}
                  maxLength={f.type === "password" ? 128 : undefined}
                  autoComplete={f.type === "password" ? "new-password" : undefined}
                />
              )}{" "}
              {f.hint && <small>{f.hint}</small>}
            </label>
          ))}
        </div>
        <Notice error={error} />
        {success && <p role="status">{success}</p>}
        <button className="primary" type="submit">
          {busy ? "Salvando…" : submit}
        </button>
      </fieldset>
    </form>
  );
}
export function Loading({ loading, error }: { loading: boolean; error: string }) {
  return (
    <>
      {loading && <p role="status">Carregando…</p>}
      <Notice error={error} />
    </>
  );
}
export const amount = (value: string) => {
  const s = value.replace(",", ".");
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(s))
    throw new Error("Use um valor com até duas casas decimais.");
  return `${s.split(".")[0]}.${(s.split(".")[1] ?? "").padEnd(2, "0")}`;
};
