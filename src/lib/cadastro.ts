/**
 * Validação do cadastro completo de aluno — COMPARTILHADA entre API e front.
 *
 * A API (POST /api/v1/alunos/cadastro) valida com `cadastroAlunoSchema`;
 * o formulário multi-etapas da Fase 2 reutiliza os mesmos schemas por etapa
 * (acesso → treino → pessoal → responsável → emergência → saúde → termos).
 * O banco repete as regras críticas (CPF, menoridade, matrícula) como última defesa.
 */
import { z } from "zod";
import {
  MODALIDADES,
  MODALIDADE_COM_FAIXA,
  NIVEIS_TECNICOS,
  NIVEL_ROTULO,
  type Modalidade,
  type NivelTecnico,
} from "../types/contract";

export const MAIORIDADE = 18;
/** Versão vigente dos termos (regulamento, uso de imagem, LGPD/saúde). */
export const TERMOS_VERSAO_ATUAL = "2026-11";

export const GENEROS = ["masculino", "feminino", "outro"] as const;
export const PARENTESCOS = ["pai", "mae", "tutor", "outro"] as const;
export const TIPOS_SANGUINEOS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;

const digits = (v: string) => v.replace(/\D/g, "");

/** CPF pelos dígitos verificadores (aceita com ou sem máscara). */
export function cpfValido(raw: string) {
  const c = digits(raw);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dv = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(c[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return dv(9) === Number(c[9]) && dv(10) === Number(c[10]);
}

/** "Hoje" no fuso da academia (YYYY-MM-DD), igual ao fn_hoje_sp() do banco. */
export function hojeSP(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Idade completa em anos na data `hoje` (padrão: hoje em São Paulo). */
export function idade(nascimento: string, hoje = hojeSP()) {
  const [ay, am, ad] = hoje.split("-").map(Number);
  const [ny, nm, nd] = nascimento.split("-").map(Number);
  return ay - ny - (am < nm || (am === nm && ad < nd) ? 1 : 0);
}
export const menorDeIdade = (nascimento: string, hoje?: string) =>
  idade(nascimento, hoje) < MAIORIDADE;

// ----------------------------------------------------------------------------
// Campos reutilizáveis (normalizam a entrada antes de validar)
// ----------------------------------------------------------------------------
const texto = (max: number) => z.string().trim().min(1, "Campo obrigatório.").max(max);
const textoLivre = z
  .string()
  .trim()
  .max(2000)
  .nullish()
  .transform((v) => (v ? v : null));

export const cpfSchema = z.string().transform(digits).refine(cpfValido, "CPF inválido.");

export const cepSchema = z
  .string()
  .transform(digits)
  .pipe(z.string().regex(/^\d{8}$/, "CEP deve ter 8 dígitos."));

/** Telefone em E.164 sem "+". DDD + número brasileiro recebe o 55 automaticamente. */
export const telefoneSchema = z
  .string()
  .transform((v) => {
    const d = digits(v);
    return d.length === 10 || d.length === 11 ? `55${d}` : d;
  })
  .pipe(z.string().regex(/^[1-9]\d{9,14}$/, "Telefone inválido: informe DDD + número."));

export const dataNascimentoSchema = z.iso
  .date("Data inválida.")
  .refine((d) => d >= "1900-01-01", "Data de nascimento inválida.")
  .refine((d) => d <= hojeSP(), "Data de nascimento no futuro.");

/** Data de matrícula: não pode ser futura (a anterioridade ao nascimento é checada no cadastro). */
export const dataMatriculaSchema = z.iso
  .date("Data inválida.")
  .refine((d) => d >= "1900-01-01", "Data de matrícula inválida.")
  .refine((d) => d <= hojeSP(), "Data de matrícula não pode ser futura.");

/** Modalidades da ficha: Jiu-Jitsu, Muay Thai, Boxe, MMA (mesma lista do enum do banco). */
export const modalidadeSchema = z.enum(MODALIDADES, {
  error: `Modalidade inválida. Opções: ${MODALIDADES.join(", ")}.`,
});

// ----------------------------------------------------------------------------
// Nível por modalidade
//   Jiu-Jitsu          → faixa + grau obrigatórios, sem nível
//   Boxe, Muay Thai, MMA → nível ∈ Iniciante | Intermediário | Avançado, sem faixa/grau
// O banco repete a regra (ck_aluno_nivel_modalidade) e espelha o rótulo do
// nível em `faixa` para quem só lê a faixa (listas, carteirinha).
// ----------------------------------------------------------------------------
const semAcento = (v: unknown) =>
  typeof v === "string"
    ? v
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .trim()
        .toLowerCase()
    : v;

/** Aceita "Intermediário", "intermediario", " AVANÇADO "… e grava o código. */
export const nivelSchema = z.preprocess(
  semAcento,
  z.enum(NIVEIS_TECNICOS, {
    error: "Nível inválido. Opções: Iniciante, Intermediário, Avançado.",
  }),
);

/** Campos de graduação: cada modalidade usa um subconjunto (ver validação abaixo). */
export const graduacaoCampos = {
  /** Jiu-Jitsu: faixa atual (ex.: "Faixa branca", "Azul"). */
  faixa: texto(40).optional(),
  /** Jiu-Jitsu: grau dentro da faixa (0 = sem grau, 1 = 1º grau…). */
  grau: z.number("Grau deve ser um número.").int().min(0).max(20).optional(),
  /** Boxe, Muay Thai e MMA: nível técnico. */
  nivel: nivelSchema.optional(),
};

type Graduacao = { modalidade: Modalidade; faixa?: string; grau?: number; nivel?: NivelTecnico };

export function validarNivelPorModalidade(
  t: Graduacao,
  ctx: z.RefinementCtx,
  path: PropertyKey[] = [],
) {
  const erro = (campo: string, message: string) =>
    ctx.addIssue({ code: "custom", path: [...path, campo], message });
  if (t.modalidade === MODALIDADE_COM_FAIXA) {
    if (t.faixa === undefined) erro("faixa", "Jiu-Jitsu exige a faixa.");
    if (t.grau === undefined) erro("grau", "Jiu-Jitsu exige o grau.");
    if (t.nivel !== undefined) erro("nivel", "Jiu-Jitsu usa faixa e grau, não nível.");
  } else {
    if (t.nivel === undefined)
      erro("nivel", "Informe o nível: Iniciante, Intermediário ou Avançado.");
    if (t.faixa !== undefined) erro("faixa", "Esta modalidade usa nível, não faixa.");
    if (t.grau !== undefined) erro("grau", "Esta modalidade usa nível, não grau.");
  }
}

/** Converte a graduação validada nas colunas do banco. */
export function colunasGraduacao(t: Graduacao) {
  return t.modalidade === MODALIDADE_COM_FAIXA
    ? { faixa: t.faixa!, graduacao_nivel: t.grau!, nivel: null }
    : { faixa: NIVEL_ROTULO[t.nivel!], graduacao_nivel: 0, nivel: t.nivel! };
}

/** Graduação isolada (troca de modalidade no PATCH /alunos/:id). */
export const graduacaoSchema = z
  .strictObject({ modalidade: modalidadeSchema, ...graduacaoCampos })
  .superRefine((t, ctx) => validarNivelPorModalidade(t, ctx));

// ----------------------------------------------------------------------------
// Grupos do cadastro, na ordem da ficha do professor:
//   acesso → treino → pessoal → responsável (se menor) → emergência → saúde → termos
// ----------------------------------------------------------------------------

/** 1. Dados de acesso (login do aluno). */
export const acessoSchema = z.strictObject({
  nome: texto(120).refine((v) => v.length >= 2, "Informe o nome completo."),
  email: z.email("E-mail inválido.").max(254),
  senha_inicial: z.string().min(8, "Mínimo de 8 caracteres.").max(128),
});

/** 2. Dados operacionais — "Dados do treino" da ficha. */
export const treinoSchema = z
  .strictObject({
    modalidade: modalidadeSchema,
    ...graduacaoCampos,
    data_matricula: dataMatriculaSchema,
    /** Professor(a) responsável pela turma. */
    professor_responsavel: texto(120),
  })
  .superRefine((t, ctx) => validarNivelPorModalidade(t, ctx));

/** 3. Dados pessoais de "blindagem" (identificação e contato). */
export const pessoalSchema = z.strictObject({
  cpf: cpfSchema,
  /** Opcional: sem ele, o WhatsApp do responsável vira o canal principal. */
  whatsapp: telefoneSchema.nullish().transform((v) => v ?? null),
  data_nascimento: dataNascimentoSchema,
  genero: z.enum(GENEROS),
  rg: texto(20),
  endereco: texto(200),
  bairro: texto(80),
  cidade: texto(80),
  cep: cepSchema,
});

/** 4. Responsável legal ("Nome do Pai/Mãe (se menor)"). */
export const novoResponsavelSchema = z.strictObject({
  nome: texto(120).refine((v) => v.length >= 2, "Informe o nome completo."),
  parentesco: z.enum(PARENTESCOS),
  whatsapp: telefoneSchema,
  telefone_emergencia: telefoneSchema,
  email: z
    .email("E-mail inválido.")
    .max(254)
    .nullish()
    .transform((v) => v ?? null),
});
/** Novo responsável OU vínculo a um já cadastrado (irmãos). */
export const responsavelSchema = z.union([z.strictObject({ id: z.uuid() }), novoResponsavelSchema]);

/** 5. Contato de emergência — ficha §4, obrigatório para todo aluno. */
export const contatoEmergenciaSchema = z.strictObject({
  nome: texto(120).refine((v) => v.length >= 2, "Informe o nome completo."),
  parentesco: texto(40),
  telefone: telefoneSchema,
  telefone2: telefoneSchema.nullish().transform((v) => v ?? null),
});

/** 6. Saúde / anamnese — ficha §3. Campo vazio = "Não". */
export const saudeSchema = z.strictObject({
  tipo_sanguineo: z
    .enum(TIPOS_SANGUINEOS)
    .nullish()
    .transform((v) => v ?? null),
  condicoes_medicas: textoLivre,
  lesoes_cronicas: textoLivre,
  medicacao_continua: textoLivre,
  artes_marciais_anteriores: textoLivre,
});

/** 7. Termo de responsabilidade e autorizações — ficha §5. */
export const termosSchema = z.strictObject({
  aceito: z.literal(true, "É necessário aceitar o termo de responsabilidade."),
  versao: z.string().trim().min(1).max(20),
  /** Uso de imagem/voz na divulgação do CT (resposta explícita, sim ou não). */
  autoriza_uso_imagem: z.boolean("Responda se autoriza o uso de imagem."),
  /** Inclusão nos grupos de WhatsApp da turma ("Autorizo" / "Não autorizo"). */
  autoriza_grupo_whatsapp: z.boolean("Responda se autoriza a inclusão no grupo de WhatsApp."),
});

export const cadastroAlunoSchema = z
  .strictObject({
    acesso: acessoSchema,
    treino: treinoSchema,
    pessoal: pessoalSchema,
    responsavel: responsavelSchema.optional(),
    contato_emergencia: contatoEmergenciaSchema,
    saude: saudeSchema,
    termos: termosSchema,
  })
  .superRefine((b, ctx) => {
    if (menorDeIdade(b.pessoal.data_nascimento) && !b.responsavel)
      ctx.addIssue({
        code: "custom",
        path: ["responsavel"],
        message: `Aluno menor de ${MAIORIDADE} anos: os dados do responsável são obrigatórios.`,
      });
    if (b.treino.data_matricula < b.pessoal.data_nascimento)
      ctx.addIssue({
        code: "custom",
        path: ["treino", "data_matricula"],
        message: "Data de matrícula anterior à data de nascimento.",
      });
  });

/** Payload que o front envia (antes da normalização). */
export type CadastroAlunoInput = z.input<typeof cadastroAlunoSchema>;
/** Dados já normalizados/validados (o que a API grava). */
export type CadastroAluno = z.output<typeof cadastroAlunoSchema>;
