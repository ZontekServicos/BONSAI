/**
 * Tipos do domínio — espelho do system_contract v1.0 (database/schema.sql).
 *
 * Convenções de serialização (API <-> front):
 *  - UUID, Date e Timestamp trafegam como string (ISO 8601; Date = "YYYY-MM-DD").
 *  - Decimal trafega como string ("150.00") para não perder precisão em float.
 *  - Campos marcados [EXT] são extensões ao contrato v1.0.
 */

export type UUID = string;
/** "YYYY-MM-DD" */
export type ISODate = string;
/** ISO 8601 com timezone */
export type ISOTimestamp = string;
/** Valor monetário serializado, ex.: "150.00" */
export type Decimal = string;

// ---------------------------------------------------------------------------
// Enums (arrays `as const` servem tanto para tipos quanto para <select>/validação)
// ---------------------------------------------------------------------------
export const USER_ROLES = ["admin", "aluno"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUS = ["ativo", "inativo", "inadimplente"] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const MODALIDADES = ["boxe", "jiu_jitsu", "muay_thai"] as const;
export type Modalidade = (typeof MODALIDADES)[number];

export const PAYMENT_STATUS = ["pendente", "pago", "atrasado"] as const;
export type PaymentStatus = (typeof PAYMENT_STATUS)[number];

export const CASH_FLOW_TIPOS = ["entrada", "saida"] as const;
export type CashFlowTipo = (typeof CASH_FLOW_TIPOS)[number];

export const CASH_FLOW_CATEGORIAS = ["mensalidade", "loja", "sangria", "outros"] as const;
export type CashFlowCategoria = (typeof CASH_FLOW_CATEGORIAS)[number];

export const METODOS_PAGAMENTO = [
  "pix",
  "dinheiro",
  "cartao_credito",
  "cartao_debito",
  "boleto",
  "transferencia",
] as const;
export type MetodoPagamento = (typeof METODOS_PAGAMENTO)[number];

// ---------------------------------------------------------------------------
// Entidades
// ---------------------------------------------------------------------------

/** `users` — password_hash nunca sai da API, por isso não existe no front. */
export interface User {
  id: UUID;
  nome: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  created_at: ISOTimestamp;
}

/** Persistência apenas no servidor; nunca usar como resposta HTTP. */
export interface UserRecord extends User {
  password_hash: string;
}

export interface AlunoProfile {
  user_id: UUID;
  /** [EXT] número sequencial exibido na carteirinha */
  numero_matricula: number;
  modalidade: Modalidade;
  faixa: string;
  graduacao_nivel: number;
  total_presencas: number;
  data_matricula: ISODate;
}

/** `financeiro` — uma mensalidade */
export interface Financeiro {
  payment_id: UUID;
  user_id: UUID;
  valor: Decimal;
  data_vencimento: ISODate;
  data_pagamento: ISODate | null;
  status: PaymentStatus;
  metodo_pagamento: MetodoPagamento | null;
}

export interface InventoryProduct {
  product_id: UUID;
  nome: string;
  preco: Decimal;
  estoque_atual: number;
  categoria: string;
  /** [EXT] soft-delete */
  ativo: boolean;
}

export interface LojaVenda {
  sale_id: UUID;
  user_id: UUID;
  product_id: UUID;
  quantidade: number;
  /** [EXT] snapshot do preço no momento da venda */
  preco_unitario: Decimal;
  /** [EXT] */
  desconto: Decimal;
  valor_total: Decimal;
  /** [EXT] */
  metodo_pagamento: MetodoPagamento;
  /** [EXT] admin que registrou */
  vendido_por: UUID;
  data_venda: ISOTimestamp;
}

export interface CashFlow {
  transaction_id: UUID;
  tipo: CashFlowTipo;
  valor: Decimal;
  motivo: string;
  categoria: CashFlowCategoria;
  data: ISOTimestamp;
  /** [EXT] origem quando categoria = 'mensalidade' */
  payment_id: UUID | null;
  /** [EXT] origem quando categoria = 'loja' */
  sale_id: UUID | null;
  /** [EXT] */
  registrado_por: UUID;
}

export interface Attendance {
  attendance_id: UUID;
  user_id: UUID;
  check_in: ISOTimestamp;
  check_out: ISOTimestamp | null;
  /** [EXT] encerrado automaticamente pelo job */
  fechado_auto: boolean;
}

/** [EXT] histórico de promoções */
export interface GraduacaoHistorico {
  id: UUID;
  user_id: UUID;
  modalidade: Modalidade;
  faixa_anterior: string | null;
  graduacao_anterior: number | null;
  faixa_nova: string;
  graduacao_nova: number;
  data_graduacao: ISODate;
  promovido_por: UUID;
  observacao: string | null;
}

// ---------------------------------------------------------------------------
// Composições usadas pela API
// ---------------------------------------------------------------------------

export type Aluno = User & { role: "aluno"; perfil: AlunoProfile };

/** Payload do JWT de acesso */
export interface AccessTokenClaims {
  sub: UUID;
  role: UserRole;
  /** Informativo; autorização usa o estado atual do banco. */
  status: UserStatus;
  /** [EXT] família de sessão revogável */
  sid: UUID;
  typ: "access";
  iss: "bonsai";
  aud: "bonsai-api";
  iat: number;
  exp: number;
}

export interface AuthResponse {
  access_token: string;
  /** segundos */
  expires_in: number;
  user: User;
}

export interface Paginated<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

export interface Carteirinha {
  numero_matricula: number;
  nome: string;
  modalidade: Modalidade;
  faixa: string;
  graduacao_nivel: number;
  data_matricula: ISODate;
  total_presencas: number;
  /** JWT curto (typ = 'carteirinha') renderizado como QR Code */
  qr_token: string;
  /** quando o front deve pedir um novo QR */
  qr_expires_at: ISOTimestamp;
}

export interface PendenciaFinanceira {
  payment_id: UUID;
  valor: Decimal;
  data_vencimento: ISODate;
  dias_atraso: number;
}

export interface BalancoDiario {
  dia: ISODate;
  entradas_mensalidade: Decimal;
  entradas_loja: Decimal;
  entradas_outros: Decimal;
  total_entradas: Decimal;
  sangrias: Decimal;
  saidas_outros: Decimal;
  total_saidas: Decimal;
  saldo: Decimal;
  qtd_lancamentos: number;
}

export interface PresenteAgora {
  attendance_id: UUID;
  user_id: UUID;
  nome: string;
  modalidade: Modalidade;
  faixa: string;
  graduacao_nivel: number;
  check_in: ISOTimestamp;
}

export type PresencaEvento = {
  evento: "check_in" | "check_out";
  attendance_id: UUID;
  user_id: UUID;
  em: ISOTimestamp;
};

// ---------------------------------------------------------------------------
// Erros — formato único em toda a API
// ---------------------------------------------------------------------------
export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "CREDENCIAIS_INVALIDAS"
  | "TOKEN_EXPIRADO"
  | "NAO_AUTENTICADO"
  | "SEM_PERMISSAO"
  | "NAO_ENCONTRADO"
  | "EMAIL_JA_CADASTRADO"
  | "ALUNO_INATIVO"
  | "CARTEIRINHA_BLOQUEADA"
  | "QR_INVALIDO"
  | "CHECKIN_JA_ABERTO"
  | "SEM_CHECKIN_ABERTO"
  | "MENSALIDADE_JA_PAGA"
  | "MENSALIDADE_DUPLICADA"
  | "ESTOQUE_INSUFICIENTE"
  | "PRODUTO_INATIVO"
  | "RATE_LIMITED"
  | "ERRO_INTERNO"
  | "CONFLITO"
  | "IDEMPOTENCY_CONFLICT";

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
