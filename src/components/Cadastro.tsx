/**
 * Ficha de cadastro pelo próprio aluno, aberta por link de convite.
 *
 *   /cadastro?token=…  →  valida o convite  →  etapas da ficha  →  conta criada
 *
 * Sem token (ou com token inválido/expirado/usado) a página fica trancada: o
 * cadastro público só existe por convite. Cada etapa valida com os MESMOS
 * schemas Zod da API (src/lib/cadastro.ts), então o aluno vê o erro na hora
 * e o servidor repete tudo de qualquer forma.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { z } from "zod";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  LockKeyhole,
} from "lucide-react";
import { Logo } from "./Logo";
import { api, errorMessage, HttpError } from "../lib/api";
import {
  GENEROS,
  MAIORIDADE,
  PARENTESCOS,
  TERMOS_VERSAO_ATUAL,
  TIPOS_SANGUINEOS,
  acessoConviteSchema,
  cadastroConviteSchema,
  contatoEmergenciaSchema,
  hojeSP,
  menorDeIdade,
  novoResponsavelSchema,
  pessoalSchema,
  saudeSchema,
  termosSchema,
  treinoSchema,
} from "../lib/cadastro";
import {
  MODALIDADES,
  MODALIDADE_COM_FAIXA,
  NIVEIS_TECNICOS,
  NIVEL_ROTULO,
  type ConviteValido,
} from "../types/contract";
import { labels } from "./ui";

// ----------------------------------------------------------------------------
// Estado do formulário (strings, como nos inputs) e conversão para o payload
// ----------------------------------------------------------------------------
type SimNao = "" | "sim" | "nao";
const inicial = (professor: string) => ({
  acesso: { nome: "", senha_inicial: "", confirmar: "" },
  treino: {
    modalidade: MODALIDADE_COM_FAIXA as string,
    faixa: "Faixa branca",
    grau: "0",
    nivel: "iniciante",
    data_matricula: hojeSP(),
    professor_responsavel: professor,
  },
  pessoal: {
    cpf: "",
    rg: "",
    data_nascimento: "",
    genero: "",
    endereco: "",
    bairro: "",
    cidade: "",
    cep: "",
    whatsapp: "",
  },
  responsavel: { nome: "", parentesco: "", whatsapp: "", telefone_emergencia: "", email: "" },
  contato_emergencia: { nome: "", parentesco: "", telefone: "", telefone2: "" },
  saude: {
    tipo_sanguineo: "",
    condicoes: "" as SimNao,
    condicoes_medicas: "",
    lesoes: "" as SimNao,
    lesoes_cronicas: "",
    medicacao: "" as SimNao,
    medicacao_continua: "",
    artes: "" as SimNao,
    artes_marciais_anteriores: "",
  },
  termos: { aceito: false, autoriza_uso_imagem: "" as SimNao, autoriza_grupo_whatsapp: "" as SimNao },
});
type Ficha = ReturnType<typeof inicial>;
type Grupo = keyof Ficha;

const vazioNull = (v: string) => (v.trim() ? v : null);
const simNao = (v: SimNao) => (v === "" ? undefined : v === "sim");

/** Payload de cada grupo, no formato que a API espera. */
const payload = {
  acesso: (f: Ficha) => ({ nome: f.acesso.nome, senha_inicial: f.acesso.senha_inicial }),
  treino: (f: Ficha) => ({
    modalidade: f.treino.modalidade,
    ...(f.treino.modalidade === MODALIDADE_COM_FAIXA
      ? { faixa: f.treino.faixa, grau: f.treino.grau === "" ? undefined : Number(f.treino.grau) }
      : { nivel: f.treino.nivel }),
    data_matricula: f.treino.data_matricula,
    professor_responsavel: f.treino.professor_responsavel,
  }),
  pessoal: (f: Ficha) => ({
    ...f.pessoal,
    genero: f.pessoal.genero || undefined,
    whatsapp: vazioNull(f.pessoal.whatsapp),
  }),
  responsavel: (f: Ficha) => ({
    ...f.responsavel,
    parentesco: f.responsavel.parentesco || undefined,
    email: vazioNull(f.responsavel.email),
  }),
  contato_emergencia: (f: Ficha) => ({
    ...f.contato_emergencia,
    telefone2: vazioNull(f.contato_emergencia.telefone2),
  }),
  saude: (f: Ficha) => ({
    tipo_sanguineo: f.saude.tipo_sanguineo || null,
    condicoes_medicas: f.saude.condicoes === "sim" ? f.saude.condicoes_medicas : null,
    lesoes_cronicas: f.saude.lesoes === "sim" ? f.saude.lesoes_cronicas : null,
    medicacao_continua: f.saude.medicacao === "sim" ? f.saude.medicacao_continua : null,
    artes_marciais_anteriores: f.saude.artes === "sim" ? f.saude.artes_marciais_anteriores : null,
  }),
  termos: (f: Ficha) => ({
    aceito: f.termos.aceito,
    versao: TERMOS_VERSAO_ATUAL,
    autoriza_uso_imagem: simNao(f.termos.autoriza_uso_imagem),
    autoriza_grupo_whatsapp: simNao(f.termos.autoriza_grupo_whatsapp),
  }),
} satisfies Record<Grupo, (f: Ficha) => unknown>;

const schemas: Record<Grupo, z.ZodType> = {
  acesso: acessoConviteSchema,
  treino: treinoSchema,
  pessoal: pessoalSchema,
  responsavel: novoResponsavelSchema,
  contato_emergencia: contatoEmergenciaSchema,
  saude: saudeSchema,
  termos: termosSchema,
};

type Erros = Record<string, string>;
/** Regras da ficha em papel que não cabem no schema do grupo. */
function extras(g: Grupo, f: Ficha): Erros {
  const e: Erros = {};
  if (g === "acesso" && f.acesso.senha_inicial !== f.acesso.confirmar)
    e["acesso.confirmar"] = "As senhas não conferem.";
  if (g === "saude") {
    const perguntas = [
      ["condicoes", "condicoes_medicas", "Qual condição?"],
      ["lesoes", "lesoes_cronicas", "Onde é a lesão?"],
      ["medicacao", "medicacao_continua", "Quais medicamentos?"],
      ["artes", "artes_marciais_anteriores", "Quais artes marciais?"],
    ] as const;
    for (const [q, campo, pergunta] of perguntas) {
      if (!f.saude[q]) e[`saude.${q}`] = "Responda sim ou não.";
      else if (f.saude[q] === "sim" && !f.saude[campo].trim()) e[`saude.${campo}`] = pergunta;
    }
  }
  return e;
}
function validar(g: Grupo, f: Ficha): Erros {
  const e = extras(g, f);
  const r = schemas[g].safeParse(payload[g](f));
  if (!r.success)
    for (const i of r.error.issues) {
      const k = [g, ...i.path].join(".");
      e[k] ??= i.message;
    }
  return e;
}

// ----------------------------------------------------------------------------
// Peças visuais (tokens do @theme; texto ≥ 16px para o iOS não dar zoom)
// ----------------------------------------------------------------------------
const controle =
  "h-12 w-full rounded-xl border border-border-strong bg-surface-raised px-3.5 text-base text-text-main placeholder:text-text-muted transition focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/25 aria-invalid:border-primary-soft";

function Campo({
  label,
  erro,
  full,
  hint,
  children,
}: {
  label: string;
  erro?: string;
  full?: boolean;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className={`grid content-start gap-1.5 ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-sm font-semibold text-text-main">{label}</span>
      {children}
      {hint && !erro && <small className="text-xs text-text-muted">{hint}</small>}
      {erro && (
        <small role="alert" className="text-xs font-semibold text-primary-soft">
          {erro}
        </small>
      )}
    </label>
  );
}

function Escolha({
  name,
  value,
  onChange,
  opcoes,
  erro,
  label,
}: {
  name: string;
  value: string;
  onChange: (v: string) => void;
  opcoes: { value: string; label: string }[];
  erro?: string;
  label: string;
}) {
  return (
    <fieldset className="grid gap-2 sm:col-span-2">
      <legend className="mb-1.5 text-sm font-semibold text-text-main">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {opcoes.map((o) => (
          <label
            key={o.value}
            className={`inline-flex h-11 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-semibold transition has-focus-visible:ring-4 has-focus-visible:ring-primary/25 ${
              value === o.value
                ? "border-primary bg-primary-strong/25 text-text-main"
                : "border-border-strong text-text-muted hover:text-text-main"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
              className="sr-only"
            />
            {o.label}
          </label>
        ))}
      </div>
      {erro && (
        <small role="alert" className="text-xs font-semibold text-primary-soft">
          {erro}
        </small>
      )}
    </fieldset>
  );
}

const SIM_NAO = [
  { value: "sim", label: "Sim" },
  { value: "nao", label: "Não" },
];
const PARENTESCO_ROTULO: Record<string, string> = {
  pai: "Pai",
  mae: "Mãe",
  tutor: "Tutor(a) legal",
  outro: "Outro",
};
const GENERO_ROTULO: Record<string, string> = {
  masculino: "Masculino",
  feminino: "Feminino",
  outro: "Outro",
};

function Tela({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-background px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-text-main sm:px-8">
      <div className="mx-auto w-full max-w-2xl">
        <header className="flex items-center justify-between gap-4 py-2">
          <Logo priority />
        </header>
        {children}
      </div>
    </main>
  );
}

function Aviso({
  titulo,
  texto,
  icone = "erro",
}: {
  titulo: string;
  texto: string;
  icone?: "erro" | "trava" | "ok";
}) {
  const Icon = icone === "ok" ? CheckCircle2 : icone === "trava" ? LockKeyhole : CircleAlert;
  return (
    <Tela>
      <section className="mt-10 rounded-2xl border border-border bg-surface p-6 text-center sm:p-10">
        <Icon
          size={44}
          aria-hidden="true"
          className={`mx-auto ${icone === "ok" ? "text-success" : "text-primary-soft"}`}
        />
        <h1 className="mt-4 font-display text-4xl font-black uppercase italic">{titulo}</h1>
        <p className="mx-auto mt-3 max-w-md text-base text-text-muted">{texto}</p>
        <a
          href="/"
          className="mt-8 inline-flex h-12 items-center justify-center rounded-full bg-primary-strong px-8 font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary"
        >
          Ir para o login
        </a>
      </section>
    </Tela>
  );
}

// ----------------------------------------------------------------------------
// Página
// ----------------------------------------------------------------------------
type Estado =
  | { fase: "validando" }
  | { fase: "restrito" }
  | { fase: "recusado"; titulo: string; texto: string }
  | { fase: "ficha"; convite: ConviteValido }
  | { fase: "concluido"; email: string };

export function CadastroPorConvite() {
  const [token] = useState(() => new URLSearchParams(window.location.search).get("token") ?? "");
  const [estado, setEstado] = useState<Estado>({ fase: "validando" });

  // Trava de acesso: sem token não existe formulário (convite obrigatório).
  useEffect(() => {
    if (!token) {
      setEstado({ fase: "restrito" });
      return;
    }
    const controller = new AbortController();
    api<ConviteValido>(`/convites/validar/${encodeURIComponent(token)}`, {
      signal: controller.signal,
    })
      .then((convite) => setEstado({ fase: "ficha", convite }))
      .catch((e) => {
        if (controller.signal.aborted) return;
        setEstado({ fase: "recusado", titulo: "Convite indisponível", texto: errorMessage(e) });
      });
    return () => controller.abort();
  }, [token]);

  if (estado.fase === "validando")
    return (
      <Tela>
        <p role="status" className="mt-16 flex items-center justify-center gap-3 text-text-muted">
          <LoaderCircle className="animate-spin" aria-hidden="true" /> Validando convite…
        </p>
      </Tela>
    );
  if (estado.fase === "restrito")
    return (
      <Aviso
        icone="trava"
        titulo="Acesso restrito"
        texto="O cadastro de alunos é feito somente pelo link de convite enviado pela academia. Peça o seu ao seu professor."
      />
    );
  if (estado.fase === "recusado") return <Aviso titulo={estado.titulo} texto={estado.texto} />;
  if (estado.fase === "concluido")
    return (
      <Aviso
        icone="ok"
        titulo="Cadastro concluído"
        texto={`Sua ficha foi enviada. Entre com ${estado.email} e a senha que você criou.`}
      />
    );
  return (
    <Stepper
      token={token}
      convite={estado.convite}
      onDone={(email) => {
        // Tira o token da barra de endereço: o link já foi consumido.
        window.history.replaceState(null, "", "/cadastro");
        setEstado({ fase: "concluido", email });
      }}
      onRecusado={(texto) => setEstado({ fase: "recusado", titulo: "Convite indisponível", texto })}
    />
  );
}

const ETAPAS: { grupo: Grupo; titulo: string }[] = [
  { grupo: "acesso", titulo: "Acesso" },
  { grupo: "treino", titulo: "Treino" },
  { grupo: "pessoal", titulo: "Dados pessoais" },
  { grupo: "responsavel", titulo: "Responsável legal" },
  { grupo: "contato_emergencia", titulo: "Emergência" },
  { grupo: "saude", titulo: "Saúde" },
  { grupo: "termos", titulo: "Termo" },
];

function Stepper({
  token,
  convite,
  onDone,
  onRecusado,
}: {
  token: string;
  convite: ConviteValido;
  onDone: (email: string) => void;
  onRecusado: (texto: string) => void;
}) {
  const [f, setF] = useState(() => inicial(convite.convidado_por));
  const [passo, setPasso] = useState(0);
  const [erros, setErros] = useState<Erros>({});
  const [falha, setFalha] = useState("");
  const [enviando, setEnviando] = useState(false);

  const nascimentoOk = /^\d{4}-\d{2}-\d{2}$/.test(f.pessoal.data_nascimento);
  const menor = nascimentoOk && menorDeIdade(f.pessoal.data_nascimento);
  // Trava de menor: a etapa do responsável só existe (e é obrigatória) se < 18.
  const etapas = useMemo(
    () => ETAPAS.filter((e) => e.grupo !== "responsavel" || menor),
    [menor],
  );
  const atual = etapas[Math.min(passo, etapas.length - 1)];
  const ultimo = passo >= etapas.length - 1;

  const set =
    <G extends Grupo>(g: G, k: keyof Ficha[G]) =>
    (v: string | boolean) =>
      setF((s) => ({ ...s, [g]: { ...s[g], [k]: v } }));
  const err = (k: string) => erros[k];
  const input = <G extends Grupo>(g: G, k: keyof Ficha[G] & string) => ({
    name: `${g}.${k}`,
    value: String(f[g][k] ?? ""),
    onChange: (e: { target: { value: string } }) => set(g, k)(e.target.value),
    "aria-invalid": Boolean(erros[`${g}.${k}`]) || undefined,
    className: controle,
  });

  function irPara(i: number) {
    setPasso(i);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function avancar() {
    const e = validar(atual.grupo, f);
    setErros(e);
    if (Object.keys(e).length === 0) irPara(passo + 1);
  }

  async function enviar() {
    const e = validar("termos", f);
    setErros(e);
    if (Object.keys(e).length) return;
    const body = {
      acesso: payload.acesso(f),
      treino: payload.treino(f),
      pessoal: payload.pessoal(f),
      ...(menor ? { responsavel: payload.responsavel(f) } : {}),
      contato_emergencia: payload.contato_emergencia(f),
      saude: payload.saude(f),
      termos: payload.termos(f),
    };
    // Regras entre etapas (ex.: matrícula antes do nascimento): leva à etapa do erro.
    const total = cadastroConviteSchema.safeParse(body);
    if (!total.success) return mostrarErros(total.error.issues);
    setEnviando(true);
    setFalha("");
    try {
      const r = await api<{ email: string }>(`/convites/${encodeURIComponent(token)}/cadastro`, {
        method: "POST",
        body,
      });
      onDone(r.email);
    } catch (e) {
      if (e instanceof HttpError && e.status === 410) return onRecusado(e.message);
      if (e instanceof HttpError && e.code === "CPF_JA_CADASTRADO")
        return mostrarErros([{ path: ["pessoal", "cpf"], message: "CPF já cadastrado na academia." }]);
      if (e instanceof HttpError && Array.isArray(e.details))
        return mostrarErros(e.details as { path: PropertyKey[]; message: string }[]);
      setFalha(errorMessage(e));
    } finally {
      setEnviando(false);
    }
  }
  function mostrarErros(issues: readonly { path: PropertyKey[]; message: string }[]) {
    const e: Erros = {};
    for (const i of issues) e[i.path.join(".")] ??= i.message;
    setErros(e);
    const grupo = issues[0]?.path[0];
    const i = etapas.findIndex((x) => x.grupo === grupo);
    if (i >= 0) irPara(i);
    else setFalha(issues[0]?.message ?? "Revise os dados.");
  }

  const jj = f.treino.modalidade === MODALIDADE_COM_FAIXA;
  const declarante = menor ? f.responsavel.nome || "o responsável legal" : f.acesso.nome || "o aluno";

  return (
    <Tela>
      <header className="mt-6">
        <p className="text-xs font-bold tracking-[0.28em] text-primary-soft uppercase">
          Ficha de cadastro · Anamnese · Termo
        </p>
        <h1 className="mt-2 font-display text-[clamp(2rem,8vw,3.25rem)] leading-[0.95] font-black uppercase italic">
          {atual.titulo}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          Etapa {passo + 1} de {etapas.length} · convite de {convite.convidado_por}
        </p>
        <ol className="mt-4 flex gap-1.5" aria-label="Progresso">
          {etapas.map((e, i) => (
            <li
              key={e.grupo}
              aria-current={i === passo ? "step" : undefined}
              className={`h-1.5 flex-1 rounded-full ${i <= passo ? "bg-primary" : "bg-border"}`}
            >
              <span className="sr-only">{e.titulo}</span>
            </li>
          ))}
        </ol>
      </header>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ultimo) void enviar();
          else avancar();
        }}
        className="mt-6 rounded-2xl border border-border bg-surface p-5 sm:p-8"
      >
        <fieldset disabled={enviando} className="grid min-w-0 gap-5 sm:grid-cols-2">
          {atual.grupo === "acesso" && (
            <>
              <Campo label="E-mail (do convite)" full hint="Será o seu login.">
                <input value={convite.email} readOnly className={`${controle} opacity-70`} />
              </Campo>
              <Campo label="Nome completo" full erro={err("acesso.nome")}>
                <input {...input("acesso", "nome")} autoComplete="name" />
              </Campo>
              <Campo label="Crie uma senha" erro={err("acesso.senha_inicial")} hint="Mínimo de 8 caracteres.">
                <input {...input("acesso", "senha_inicial")} type="password" autoComplete="new-password" />
              </Campo>
              <Campo label="Repita a senha" erro={err("acesso.confirmar")}>
                <input {...input("acesso", "confirmar")} type="password" autoComplete="new-password" />
              </Campo>
            </>
          )}

          {atual.grupo === "treino" && (
            <>
              <Escolha
                name="modalidade"
                label="Modalidade"
                value={f.treino.modalidade}
                onChange={set("treino", "modalidade")}
                opcoes={MODALIDADES.map((m) => ({ value: m, label: labels[m] }))}
                erro={err("treino.modalidade")}
              />
              {jj ? (
                <>
                  <Campo label="Faixa atual" erro={err("treino.faixa")}>
                    <input {...input("treino", "faixa")} />
                  </Campo>
                  <Campo label="Grau" erro={err("treino.grau")}>
                    <input {...input("treino", "grau")} type="number" min={0} max={20} inputMode="numeric" />
                  </Campo>
                </>
              ) : (
                <Escolha
                  name="nivel"
                  label="Nível"
                  value={f.treino.nivel}
                  onChange={set("treino", "nivel")}
                  opcoes={NIVEIS_TECNICOS.map((n) => ({ value: n, label: NIVEL_ROTULO[n] }))}
                  erro={err("treino.nivel")}
                />
              )}
              <Campo label="Data da matrícula" erro={err("treino.data_matricula")}>
                <input {...input("treino", "data_matricula")} type="date" max={hojeSP()} />
              </Campo>
              <Campo label="Professor(a)" erro={err("treino.professor_responsavel")}>
                <input {...input("treino", "professor_responsavel")} />
              </Campo>
            </>
          )}

          {atual.grupo === "pessoal" && (
            <>
              <Campo label="Data de nascimento" erro={err("pessoal.data_nascimento")}>
                <input {...input("pessoal", "data_nascimento")} type="date" max={hojeSP()} />
              </Campo>
              <Campo label="Sexo" erro={err("pessoal.genero")}>
                <select {...input("pessoal", "genero")}>
                  <option value="">Selecione</option>
                  {GENEROS.map((g) => (
                    <option key={g} value={g}>
                      {GENERO_ROTULO[g]}
                    </option>
                  ))}
                </select>
              </Campo>
              {menor && (
                <p className="rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm sm:col-span-2">
                  Menor de {MAIORIDADE} anos: a próxima etapa pede os dados do responsável legal,
                  que também assina o termo.
                </p>
              )}
              <Campo label="CPF" erro={err("pessoal.cpf")}>
                <input {...input("pessoal", "cpf")} inputMode="numeric" placeholder="000.000.000-00" />
              </Campo>
              <Campo label="RG" erro={err("pessoal.rg")}>
                <input {...input("pessoal", "rg")} />
              </Campo>
              <Campo label="Endereço" full erro={err("pessoal.endereco")}>
                <input {...input("pessoal", "endereco")} autoComplete="street-address" />
              </Campo>
              <Campo label="Bairro" erro={err("pessoal.bairro")}>
                <input {...input("pessoal", "bairro")} />
              </Campo>
              <Campo label="Cidade" erro={err("pessoal.cidade")}>
                <input {...input("pessoal", "cidade")} autoComplete="address-level2" />
              </Campo>
              <Campo label="CEP" erro={err("pessoal.cep")}>
                <input {...input("pessoal", "cep")} inputMode="numeric" autoComplete="postal-code" />
              </Campo>
              <Campo
                label="WhatsApp"
                erro={err("pessoal.whatsapp")}
                hint={menor ? "Opcional: sem ele, usamos o do responsável." : "Com DDD."}
              >
                <input {...input("pessoal", "whatsapp")} type="tel" autoComplete="tel" />
              </Campo>
            </>
          )}

          {atual.grupo === "responsavel" && (
            <>
              <p className="text-sm text-text-muted sm:col-span-2">
                Obrigatório para menores de {MAIORIDADE} anos. O responsável recebe os avisos da
                academia quando o aluno não tem WhatsApp próprio.
              </p>
              <Campo label="Nome do pai, mãe ou responsável" full erro={err("responsavel.nome")}>
                <input {...input("responsavel", "nome")} />
              </Campo>
              <Campo label="Parentesco" erro={err("responsavel.parentesco")}>
                <select {...input("responsavel", "parentesco")}>
                  <option value="">Selecione</option>
                  {PARENTESCOS.map((p) => (
                    <option key={p} value={p}>
                      {PARENTESCO_ROTULO[p]}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="E-mail (opcional)" erro={err("responsavel.email")}>
                <input {...input("responsavel", "email")} type="email" />
              </Campo>
              <Campo label="WhatsApp" erro={err("responsavel.whatsapp")}>
                <input {...input("responsavel", "whatsapp")} type="tel" />
              </Campo>
              <Campo label="Telefone de emergência" erro={err("responsavel.telefone_emergencia")}>
                <input {...input("responsavel", "telefone_emergencia")} type="tel" />
              </Campo>
            </>
          )}

          {atual.grupo === "contato_emergencia" && (
            <>
              {menor && (
                <button
                  type="button"
                  onClick={() =>
                    setF((s) => ({
                      ...s,
                      contato_emergencia: {
                        nome: s.responsavel.nome,
                        parentesco: PARENTESCO_ROTULO[s.responsavel.parentesco] ?? "",
                        telefone: s.responsavel.telefone_emergencia,
                        telefone2: s.responsavel.whatsapp,
                      },
                    }))
                  }
                  className="h-11 rounded-full border border-border-strong px-4 text-sm font-semibold text-text-main transition hover:border-primary sm:col-span-2 sm:justify-self-start"
                >
                  Usar os dados do responsável
                </button>
              )}
              <Campo label="Nome" full erro={err("contato_emergencia.nome")}>
                <input {...input("contato_emergencia", "nome")} />
              </Campo>
              <Campo label="Parentesco" erro={err("contato_emergencia.parentesco")}>
                <input {...input("contato_emergencia", "parentesco")} placeholder="Ex.: Mãe, Cônjuge" />
              </Campo>
              <Campo label="Telefone 1" erro={err("contato_emergencia.telefone")}>
                <input {...input("contato_emergencia", "telefone")} type="tel" />
              </Campo>
              <Campo label="Telefone 2 (opcional)" erro={err("contato_emergencia.telefone2")}>
                <input {...input("contato_emergencia", "telefone2")} type="tel" />
              </Campo>
            </>
          )}

          {atual.grupo === "saude" && (
            <>
              <p className="text-sm text-text-muted sm:col-span-2">
                Dados de saúde são sensíveis (LGPD): ficam visíveis só para a equipe da academia e
                servem para a sua segurança no treino.
              </p>
              <Campo label="Tipo sanguíneo" erro={err("saude.tipo_sanguineo")}>
                <select {...input("saude", "tipo_sanguineo")}>
                  <option value="">Não sei</option>
                  {TIPOS_SANGUINEOS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </Campo>
              {(
                [
                  ["condicoes", "condicoes_medicas", "Possui alguma condição médica (alergias, asma, diabetes, hipertensão)?", "Se sim, qual?"],
                  ["lesoes", "lesoes_cronicas", "Possui lesões crônicas ou antigas (joelho, ombro, coluna)?", "Se sim, onde?"],
                  ["medicacao", "medicacao_continua", "Usa medicamentos contínuos?", "Quais?"],
                  ["artes", "artes_marciais_anteriores", "Já praticou artes marciais antes?", "Quais?"],
                ] as const
              ).map(([q, campo, pergunta, detalhe]) => (
                <div key={q} className="grid gap-3 sm:col-span-2">
                  <Escolha
                    name={q}
                    label={pergunta}
                    value={f.saude[q]}
                    onChange={set("saude", q)}
                    opcoes={SIM_NAO}
                    erro={err(`saude.${q}`)}
                  />
                  {f.saude[q] === "sim" && (
                    <Campo label={detalhe} full erro={err(`saude.${campo}`)}>
                      <textarea
                        {...input("saude", campo)}
                        rows={2}
                        maxLength={2000}
                        className={`${controle} h-auto py-3`}
                      />
                    </Campo>
                  )}
                </div>
              ))}
            </>
          )}

          {atual.grupo === "termos" && (
            <>
              <div className="rounded-xl border border-border bg-surface-raised p-4 text-sm leading-relaxed text-text-main sm:col-span-2">
                <p>
                  Eu, <strong>{declarante}</strong>
                  {menor && (
                    <>
                      , responsável legal por <strong>{f.acesso.nome || "o aluno"}</strong>
                    </>
                  )}
                  , declaro {menor ? "que o aluno está" : "estar"} em boas condições de saúde física
                  e mental para a prática de artes marciais. Estou ciente de que se trata de uma
                  atividade de contato e assumo os riscos inerentes a lesões.
                </p>
                <p className="mt-2 text-text-muted">Versão do termo: {TERMOS_VERSAO_ATUAL}</p>
              </div>
              <label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={f.termos.aceito}
                  onChange={(e) => set("termos", "aceito")(e.target.checked)}
                  className="mt-0.5 size-5 shrink-0 accent-primary"
                />
                <span className="text-sm">
                  Li e aceito o termo de responsabilidade.
                  {err("termos.aceito") && (
                    <small role="alert" className="mt-1 block text-xs font-semibold text-primary-soft">
                      {err("termos.aceito")}
                    </small>
                  )}
                </span>
              </label>
              <Escolha
                name="imagem"
                label="Autoriza o uso de imagem e voz para divulgação do CT Bonsai Jiu-Jitsu Fight?"
                value={f.termos.autoriza_uso_imagem}
                onChange={set("termos", "autoriza_uso_imagem")}
                opcoes={[
                  { value: "sim", label: "Autorizo" },
                  { value: "nao", label: "Não autorizo" },
                ]}
                erro={err("termos.autoriza_uso_imagem")}
              />
              <Escolha
                name="grupo"
                label="Autoriza a inclusão nos grupos de WhatsApp da turma?"
                value={f.termos.autoriza_grupo_whatsapp}
                onChange={set("termos", "autoriza_grupo_whatsapp")}
                opcoes={[
                  { value: "sim", label: "Autorizo" },
                  { value: "nao", label: "Não autorizo" },
                ]}
                erro={err("termos.autoriza_grupo_whatsapp")}
              />
            </>
          )}
        </fieldset>

        {falha && (
          <p role="alert" className="mt-5 rounded-xl border border-primary/60 bg-primary-strong/15 px-4 py-3 text-sm">
            {falha}
          </p>
        )}

        <div className="mt-7 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => irPara(passo - 1)}
            disabled={passo === 0 || enviando}
            className="inline-flex h-12 items-center gap-1 rounded-full px-4 font-semibold text-text-muted transition hover:text-text-main disabled:invisible"
          >
            <ChevronLeft size={20} aria-hidden="true" /> Voltar
          </button>
          <button
            type="submit"
            disabled={enviando}
            className="inline-flex h-12 items-center gap-2 rounded-full bg-primary-strong px-7 font-bold text-text-main transition hover:brightness-110 focus-visible:outline-primary"
          >
            {enviando ? (
              <>
                <LoaderCircle size={20} className="animate-spin" aria-hidden="true" /> Enviando…
              </>
            ) : ultimo ? (
              "Enviar ficha"
            ) : (
              <>
                Continuar <ChevronRight size={20} aria-hidden="true" />
              </>
            )}
          </button>
        </div>
      </form>
    </Tela>
  );
}
