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
/** professor: alunos, graduações e presença — sem financeiro, caixa, loja e dashboard. */
export const USER_ROLES = ["admin", "professor", "aluno"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUS = ["ativo", "inativo", "inadimplente"] as const;
export type UserStatus = (typeof USER_STATUS)[number];

export const MODALIDADES = ["boxe", "jiu_jitsu", "muay_thai", "mma"] as const;
export type Modalidade = (typeof MODALIDADES)[number];
/** Única modalidade graduada por faixa + grau; as demais usam nível técnico. */
export const MODALIDADE_COM_FAIXA = "jiu_jitsu" satisfies Modalidade;
export const NIVEIS_TECNICOS = ["iniciante", "intermediario", "avancado"] as const;
export type NivelTecnico = (typeof NIVEIS_TECNICOS)[number];
export const NIVEL_ROTULO: Record<NivelTecnico, string> = {
  iniciante: "Iniciante",
  intermediario: "Intermediário",
  avancado: "Avançado",
};

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
  /** Jiu-Jitsu: faixa. Demais modalidades: rótulo do nível (espelhado pelo banco). */
  faixa: string;
  /** Grau da faixa (Jiu-Jitsu); 0 nas demais modalidades. */
  graduacao_nivel: number;
  /** Nível técnico (fora do Jiu-Jitsu); null no Jiu-Jitsu e em fichas legadas pendentes. */
  nivel: NivelTecnico | null;
  /** Foto de perfil (link servido pela API; null = sem foto). */
  foto_url: string | null;
  /** Metros (ex.: 1.85). Informado pelo próprio aluno. */
  altura: number | null;
  /** Quilos (ex.: 82.5). Informado pelo próprio aluno. */
  peso: number | null;
  /** Última vez que o aluno informou/confirmou altura ou peso. */
  medidas_atualizadas_em: ISOTimestamp | null;
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
  /** Texto do catálogo do aluno (0009). */
  descricao: string | null;
  /** Foto do produto (link servido pela API; null = sem foto). */
  imagem_url: string | null;
}

/** GET /loja/produtos — catálogo do aluno (inventory_product com ativo = true). */
export interface ProdutoLoja {
  id: UUID;
  nome: string;
  descricao: string | null;
  preco: Decimal;
  imagem_url: string | null;
  estoque: number;
  categoria: string;
}

export type PedidoLojaStatus = "solicitado" | "atendido" | "cancelado";

/** `pedidos_loja` — intenção de compra (não baixa estoque nem lança no caixa). */
export interface PedidoLoja {
  id: UUID;
  user_id: UUID;
  product_id: UUID;
  quantidade: number;
  preco_unitario: Decimal;
  status: PedidoLojaStatus;
  atendido_por: UUID | null;
  atendido_em: ISOTimestamp | null;
  created_at: ISOTimestamp;
}

/** POST /loja/pedido */
export interface PedidoLojaCriado {
  pedido: PedidoLoja;
  /** Conversa com o WhatsApp da loja com a mensagem pronta. */
  whatsapp_url: string;
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

/** Responsável legal/financeiro (obrigatório para menores de 18 anos). */
export interface Responsavel {
  id: UUID;
  nome: string;
  parentesco: "pai" | "mae" | "tutor" | "outro";
  /** E.164 sem "+", ex.: 5511987654321 */
  whatsapp: string;
  telefone_emergencia: string;
  email: string | null;
}

/** Histórico de saúde — dado sensível (LGPD art. 11): só staff e o próprio aluno. */
export interface HistoricoSaude {
  tipo_sanguineo: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-" | null;
  condicoes_medicas: string | null;
  lesoes_cronicas: string | null;
  medicacao_continua: string | null;
  artes_marciais_anteriores: string | null;
  atualizado_por: UUID | null;
  created_at: ISOTimestamp;
  updated_at: ISOTimestamp;
}

/** Ficha completa: GET /alunos/:id/ficha e resposta de POST /alunos/cadastro. */
export type FichaAluno = Aluno & {
  ficha: {
    genero: "masculino" | "feminino" | "outro" | null;
    rg: string | null;
    cpf: string | null;
    data_nascimento: ISODate | null;
    endereco: string | null;
    bairro: string | null;
    cidade: string | null;
    cep: string | null;
    whatsapp: string | null;
    professor_responsavel: string | null;
    idade: number | null;
    menor_de_idade: boolean | null;
    /** Perfil criado antes da 0006 e ainda sem contato de emergência/nível. */
    ficha_pendente: boolean;
    /** Ficha §4 — obrigatório; null só em fichas legadas pendentes. */
    contato_emergencia: {
      nome: string;
      parentesco: string;
      telefone: string;
      telefone2: string | null;
    } | null;
    termos_aceitos: boolean;
    termos_aceitos_em: ISOTimestamp | null;
    termos_versao: string | null;
    autoriza_uso_imagem: boolean | null;
    autoriza_grupo_whatsapp: boolean | null;
    responsavel: Responsavel | null;
    saude: HistoricoSaude | null;
    /** Canal de notificação: WhatsApp do aluno, senão o do responsável. */
    contato_principal: { whatsapp: string | null; origem: "aluno" | "responsavel" | null };
  };
};

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

/** Status da competência atual no painel: pago = há entrada no cash_flow. */
export type StatusMensalidadePainel = "pago" | "pendente";

/** GET /financeiro/mensalidades — um item por aluno não inativo (sem valores). */
export interface MensalidadePainelItem {
  user_id: UUID;
  nome: string;
  status_aluno: UserStatus;
  modalidade: Modalidade;
  /** Cobrança do mês, se já gerada. */
  payment_id: UUID | null;
  /** Vencimento da cobrança do mês, ou o previsto pelo dia padrão se não gerada. */
  data_vencimento: ISODate;
  cobranca_gerada: boolean;
  pago_em: ISOTimestamp | null;
  status: StatusMensalidadePainel;
  /** Valor da cobrança do mês. Só vem para o gestor (admin); null sem cobrança. */
  valor?: Decimal | null;
}

/** POST /financeiro/baixa (admin). */
export interface BaixaMensalidadeInput {
  payment_id: UUID;
  /** Valor efetivamente recebido ("150.00"); pode diferir do cobrado. */
  valor_pago: Decimal;
  /** Padrão: pix. */
  metodo_pagamento?: MetodoPagamento;
}
/** POST /notificacoes/cobrar (admin): mensagem de cobrança + link wa.me. */
export interface CobrancaWhatsApp {
  payment_id: UUID;
  user_id: UUID;
  aluno_nome: string;
  menor_de_idade: boolean;
  /** YYYY-MM do vencimento da cobrança. */
  competencia: string;
  valor: Decimal;
  /** Menor de idade: sempre o responsável. */
  destinatario: { tipo: "aluno" | "responsavel"; nome: string; whatsapp: string };
  mensagem: string;
  whatsapp_url: string;
}
export interface BaixaMensalidade {
  mensalidade: Financeiro;
  lancamento: CashFlow;
  status_aluno: UserStatus;
}

export interface PainelMensalidades extends Paginated<MensalidadePainelItem> {
  /** YYYY-MM (mês corrente em America/Sao_Paulo). */
  competencia: string;
  /** Contagens para as abas (ignoram o filtro de status). */
  resumo: { todos: number; pago: number; pendente: number };
  /** Só para o gestor: valor sugerido ao gerar a cobrança do mês (BILLING_AMOUNT). */
  valor_padrao?: Decimal;
}

/**
 * GET /me/mensalidades/atual (aluno): a mesma linha que o gestor vê no painel
 * para este aluno, com a competência. null se o aluno estiver inativo.
 */
export interface MensalidadeAtual extends MensalidadePainelItem {
  competencia: string;
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
  | "IDEMPOTENCY_CONFLICT"
  | "CPF_JA_CADASTRADO"
  | "RESPONSAVEL_NAO_ENCONTRADO"
  | "CONVITE_INVALIDO"
  | "CONVITE_EXPIRADO"
  | "CONVITE_UTILIZADO"
  | "CONVITE_REVOGADO"
  | "LOJA_SEM_WHATSAPP"
  | "PRODUTO_ESGOTADO"
  | "PEDIDO_FINALIZADO";

export type ConviteStatus = "pendente" | "expirado" | "utilizado" | "revogado";

/** `convites` — link de cadastro (o token em si nunca é armazenado). */
export interface Convite {
  id: UUID;
  email_destinatario: string;
  whatsapp_destinatario: string | null;
  data_expiracao: ISOTimestamp;
  status: ConviteStatus;
  utilizado_em: ISOTimestamp | null;
  aluno_id: UUID | null;
  criado_por: UUID;
  criado_por_nome: string;
  created_at: ISOTimestamp;
}

/** Resposta de POST /convites — única vez em que o link (com o token) aparece. */
export interface ConviteCriado extends Convite {
  url: string;
  /** Link wa.me com a mensagem pronta, quando o WhatsApp foi informado. */
  whatsapp_url: string | null;
}

/** GET /convites/validar/:token — o mínimo para abrir o formulário. */
export interface ConviteValido {
  email: string;
  data_expiracao: ISOTimestamp;
  convidado_por: string;
}

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}
