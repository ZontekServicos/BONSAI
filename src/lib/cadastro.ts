/**
 * Validação do cadastro completo de aluno — COMPARTILHADA entre API e front.
 *
 * A API (POST /api/v1/alunos/cadastro) valida com `cadastroAlunoSchema`;
 * o formulário multi-etapas da Fase 2 reutiliza os mesmos schemas por etapa
 * (dadosAlunoSchema → saudeSchema → responsavelSchema → termosSchema).
 * O banco repete as regras críticas (CPF, menoridade) como última defesa.
 */
import { z } from "zod";
import { MODALIDADES } from "../types/contract";

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

// ----------------------------------------------------------------------------
// Etapas do cadastro
// ----------------------------------------------------------------------------
export const dadosAlunoSchema = z.strictObject({
  nome: texto(120).refine((v) => v.length >= 2, "Informe o nome completo."),
  email: z.email("E-mail inválido.").max(254),
  senha_inicial: z.string().min(8, "Mínimo de 8 caracteres.").max(128),
  genero: z.enum(GENEROS),
  rg: texto(20),
  cpf: cpfSchema,
  data_nascimento: dataNascimentoSchema,
  endereco: texto(200),
  bairro: texto(80),
  cidade: texto(80),
  cep: cepSchema,
  /** Opcional: sem ele, o WhatsApp do responsável vira o canal principal. */
  whatsapp: telefoneSchema.nullish().transform((v) => v ?? null),
  modalidade: z.enum(MODALIDADES),
  faixa: texto(40),
  graduacao_nivel: z.number().int().min(0).max(20).default(0),
  professor_responsavel: texto(120),
  data_matricula: z.iso.date().optional(),
});

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

export const termosSchema = z.strictObject({
  aceito: z.literal(true, "É necessário aceitar os termos."),
  versao: z.string().trim().min(1).max(20),
});

export const cadastroAlunoSchema = z
  .strictObject({
    aluno: dadosAlunoSchema,
    saude: saudeSchema,
    responsavel: responsavelSchema.optional(),
    termos: termosSchema,
  })
  .superRefine((b, ctx) => {
    if (menorDeIdade(b.aluno.data_nascimento) && !b.responsavel)
      ctx.addIssue({
        code: "custom",
        path: ["responsavel"],
        message: `Aluno menor de ${MAIORIDADE} anos: os dados do responsável são obrigatórios.`,
      });
  });

/** Payload que o front envia (antes da normalização). */
export type CadastroAlunoInput = z.input<typeof cadastroAlunoSchema>;
/** Dados já normalizados/validados (o que a API grava). */
export type CadastroAluno = z.output<typeof cadastroAlunoSchema>;
