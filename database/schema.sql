-- =====================================================================
-- BONSAI ERP — Schema PostgreSQL (>= 15)
-- Base: system_contract v1.0
--
-- Convenções:
--   * Dinheiro sempre em NUMERIC (nunca float). Na API trafega como string.
--   * Timestamps em TIMESTAMPTZ (UTC no disco). "Dia" de negócio é sempre
--     calculado em America/Sao_Paulo (Railway roda em UTC).
--   * Nada financeiro é apagado fisicamente: users usam soft-delete
--     (status = 'inativo') e cash_flow é append-only.
--   * Colunas marcadas com [EXT] não existem no contrato v1.0; são
--     extensões necessárias para auditoria/integridade e não quebram o contrato.
-- =====================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;    -- e-mail case-insensitive
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() (nativo no PG13+, mantido por segurança)

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
CREATE TYPE user_role           AS ENUM ('admin', 'aluno');
CREATE TYPE user_status         AS ENUM ('ativo', 'inativo', 'inadimplente');
CREATE TYPE modalidade          AS ENUM ('boxe', 'jiu_jitsu', 'muay_thai');
CREATE TYPE payment_status      AS ENUM ('pendente', 'pago', 'atrasado');
CREATE TYPE cash_flow_tipo      AS ENUM ('entrada', 'saida');
CREATE TYPE cash_flow_categoria AS ENUM ('mensalidade', 'loja', 'sangria', 'outros');

-- Domínio para método de pagamento (contrato: String) — lista fechada evita lixo.
CREATE DOMAIN metodo_pagamento AS varchar(20)
  CHECK (VALUE IN ('pix', 'dinheiro', 'cartao_credito', 'cartao_debito', 'boleto', 'transferencia'));

-- ---------------------------------------------------------------------
-- FUNÇÕES UTILITÁRIAS
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_hoje_sp() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date
$$;

CREATE OR REPLACE FUNCTION fn_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Garante que a FK aponta para um usuário com role 'aluno'.
CREATE OR REPLACE FUNCTION fn_assert_role_aluno() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND role = 'aluno') THEN
    RAISE EXCEPTION 'user_id % não pertence a um aluno', NEW.user_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- =====================================================================
-- USERS
-- =====================================================================
CREATE TABLE users (
  id             uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  nome           varchar(120) NOT NULL,
  email          citext       NOT NULL,
  password_hash  text         NOT NULL,              -- argon2id
  role           user_role    NOT NULL DEFAULT 'aluno',
  status         user_status  NOT NULL DEFAULT 'ativo',
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(), -- [EXT]

  CONSTRAINT uq_users_email          UNIQUE (email),
  CONSTRAINT ck_users_nome           CHECK (length(btrim(nome)) >= 2),
  CONSTRAINT ck_users_email_formato  CHECK (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  -- Admin nunca fica "inadimplente".
  CONSTRAINT ck_users_admin_status   CHECK (role = 'aluno' OR status <> 'inadimplente')
);

CREATE INDEX ix_users_role_status ON users (role, status);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- =====================================================================
-- REFRESH TOKENS [EXT]  — sessão JWT com rotação e revogação
-- Access token (15 min) é stateless; refresh token (30 dias) é opaco,
-- guardado apenas como hash SHA-256.
-- =====================================================================
CREATE TABLE refresh_tokens (
  token_id     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash   char(64)    NOT NULL UNIQUE,
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  replaced_by  uuid        REFERENCES refresh_tokens (token_id) ON DELETE SET NULL,
  user_agent   text,
  ip           inet,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_refresh_expira CHECK (expires_at > created_at)
);

CREATE INDEX ix_refresh_tokens_user_ativos ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- =====================================================================
-- ALUNO_PROFILE  (1:1 com users de role 'aluno')
-- =====================================================================
CREATE TABLE aluno_profile (
  user_id           uuid        PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  numero_matricula  integer     GENERATED ALWAYS AS IDENTITY UNIQUE, -- [EXT] nº legível na carteirinha
  modalidade        modalidade  NOT NULL,
  faixa             varchar(40) NOT NULL,
  graduacao_nivel   smallint    NOT NULL DEFAULT 0,
  total_presencas   integer     NOT NULL DEFAULT 0,  -- mantido por trigger em attendance
  data_matricula    date        NOT NULL DEFAULT fn_hoje_sp(),
  updated_at        timestamptz NOT NULL DEFAULT now(), -- [EXT]

  CONSTRAINT ck_aluno_graduacao CHECK (graduacao_nivel BETWEEN 0 AND 20),
  CONSTRAINT ck_aluno_presencas CHECK (total_presencas >= 0)
);

CREATE INDEX ix_aluno_profile_modalidade ON aluno_profile (modalidade);

CREATE TRIGGER trg_aluno_profile_role
  BEFORE INSERT OR UPDATE OF user_id ON aluno_profile
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

CREATE TRIGGER trg_aluno_profile_updated_at
  BEFORE UPDATE ON aluno_profile
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- =====================================================================
-- GRADUACAO_HISTORICO [EXT] — trilha de promoções de faixa/grau
-- =====================================================================
CREATE TABLE graduacao_historico (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES aluno_profile (user_id) ON DELETE CASCADE,
  modalidade          modalidade  NOT NULL,
  faixa_anterior      varchar(40),
  graduacao_anterior  smallint,
  faixa_nova          varchar(40) NOT NULL,
  graduacao_nova      smallint    NOT NULL CHECK (graduacao_nova BETWEEN 0 AND 20),
  data_graduacao      date        NOT NULL DEFAULT fn_hoje_sp(),
  promovido_por       uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  observacao          text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ix_graduacao_hist_user ON graduacao_historico (user_id, data_graduacao DESC);

-- =====================================================================
-- FINANCEIRO (mensalidades)
-- Regra de status:
--   pendente  -> ainda não venceu (ou vence hoje)
--   atrasado  -> data_vencimento < hoje e não pago
--   pago      -> data_pagamento e metodo_pagamento obrigatórios
-- O BLOQUEIO da carteirinha só ocorre após a carência (ver fn_pendencias_bloqueantes).
-- =====================================================================
CREATE TABLE financeiro (
  payment_id        uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  valor             numeric(10, 2)   NOT NULL,
  data_vencimento   date             NOT NULL,
  data_pagamento    date,
  status            payment_status   NOT NULL DEFAULT 'pendente',
  metodo_pagamento  metodo_pagamento,
  created_at        timestamptz      NOT NULL DEFAULT now(), -- [EXT]
  updated_at        timestamptz      NOT NULL DEFAULT now(), -- [EXT]

  CONSTRAINT ck_financeiro_valor      CHECK (valor > 0),
  -- Uma mensalidade por aluno por vencimento (idempotência na geração em lote).
  CONSTRAINT uq_financeiro_competencia UNIQUE (user_id, data_vencimento),
  CONSTRAINT ck_financeiro_coerencia  CHECK (
       (status =  'pago' AND data_pagamento IS NOT NULL AND metodo_pagamento IS NOT NULL)
    OR (status <> 'pago' AND data_pagamento IS NULL)
  )
);

CREATE INDEX ix_financeiro_user_status    ON financeiro (user_id, status);
CREATE INDEX ix_financeiro_abertos_venc   ON financeiro (data_vencimento) WHERE status <> 'pago';
CREATE INDEX ix_financeiro_data_pagamento ON financeiro (data_pagamento)  WHERE status =  'pago';

CREATE TRIGGER trg_financeiro_role
  BEFORE INSERT OR UPDATE OF user_id ON financeiro
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

CREATE TRIGGER trg_financeiro_updated_at
  BEFORE UPDATE ON financeiro
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- =====================================================================
-- INVENTORY_PRODUCT
-- =====================================================================
CREATE TABLE inventory_product (
  product_id     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  nome           varchar(120)   NOT NULL,
  preco          numeric(10, 2) NOT NULL,
  estoque_atual  integer        NOT NULL DEFAULT 0,
  categoria      varchar(60)    NOT NULL,
  ativo          boolean        NOT NULL DEFAULT true, -- [EXT] soft-delete
  created_at     timestamptz    NOT NULL DEFAULT now(), -- [EXT]
  updated_at     timestamptz    NOT NULL DEFAULT now(), -- [EXT]

  CONSTRAINT ck_product_preco   CHECK (preco >= 0),
  -- Última linha de defesa contra overselling (a API usa UPDATE condicional).
  CONSTRAINT ck_product_estoque CHECK (estoque_atual >= 0)
);

CREATE UNIQUE INDEX uq_product_nome_ativo ON inventory_product (lower(nome)) WHERE ativo;
CREATE INDEX ix_product_categoria         ON inventory_product (categoria)   WHERE ativo;

CREATE TRIGGER trg_product_updated_at
  BEFORE UPDATE ON inventory_product
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- =====================================================================
-- LOJA_VENDA  (uma linha por item; um "carrinho" gera N linhas na mesma transação)
-- =====================================================================
CREATE TABLE loja_venda (
  sale_id           uuid             PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  product_id        uuid             NOT NULL REFERENCES inventory_product (product_id) ON DELETE RESTRICT,
  quantidade        integer          NOT NULL,
  preco_unitario    numeric(10, 2)   NOT NULL,          -- [EXT] snapshot do preço no momento da venda
  desconto          numeric(10, 2)   NOT NULL DEFAULT 0, -- [EXT]
  valor_total       numeric(12, 2)   NOT NULL,
  metodo_pagamento  metodo_pagamento NOT NULL,           -- [EXT]
  vendido_por       uuid             NOT NULL REFERENCES users (id) ON DELETE RESTRICT, -- [EXT] admin
  data_venda        timestamptz      NOT NULL DEFAULT now(),

  CONSTRAINT ck_venda_quantidade CHECK (quantidade > 0),
  CONSTRAINT ck_venda_preco      CHECK (preco_unitario >= 0),
  CONSTRAINT ck_venda_desconto   CHECK (desconto >= 0),
  CONSTRAINT ck_venda_total      CHECK (
    valor_total >= 0 AND valor_total = round(preco_unitario * quantidade - desconto, 2)
  )
);

CREATE INDEX ix_venda_user_data    ON loja_venda (user_id, data_venda DESC);
CREATE INDEX ix_venda_product      ON loja_venda (product_id);
CREATE INDEX ix_venda_data         ON loja_venda (data_venda);

CREATE TRIGGER trg_venda_role
  BEFORE INSERT OR UPDATE OF user_id ON loja_venda
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

-- =====================================================================
-- CASH_FLOW  (livro-caixa append-only)
-- Correções são feitas com lançamento de estorno, nunca UPDATE/DELETE.
-- =====================================================================
CREATE TABLE cash_flow (
  transaction_id  uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo            cash_flow_tipo      NOT NULL,
  valor           numeric(12, 2)      NOT NULL,
  motivo          varchar(255)        NOT NULL,
  categoria       cash_flow_categoria NOT NULL,
  data            timestamptz         NOT NULL DEFAULT now(),
  payment_id      uuid UNIQUE REFERENCES financeiro (payment_id) ON DELETE RESTRICT, -- [EXT]
  sale_id         uuid UNIQUE REFERENCES loja_venda (sale_id)    ON DELETE RESTRICT, -- [EXT]
  registrado_por  uuid NOT NULL REFERENCES users (id)            ON DELETE RESTRICT, -- [EXT]

  CONSTRAINT ck_cash_flow_valor CHECK (valor > 0),
  -- Amarra categoria x tipo x origem: impede, p.ex., sangria como entrada
  -- ou mensalidade lançada duas vezes (UNIQUE em payment_id).
  CONSTRAINT ck_cash_flow_categoria CHECK (
       (categoria = 'mensalidade' AND tipo = 'entrada' AND payment_id IS NOT NULL AND sale_id IS NULL)
    OR (categoria = 'loja'        AND tipo = 'entrada' AND sale_id    IS NOT NULL AND payment_id IS NULL)
    OR (categoria = 'sangria'     AND tipo = 'saida'   AND payment_id IS NULL     AND sale_id IS NULL)
    OR (categoria = 'outros'                           AND payment_id IS NULL     AND sale_id IS NULL)
  )
);

CREATE INDEX ix_cash_flow_data           ON cash_flow (data);
CREATE INDEX ix_cash_flow_categoria_data ON cash_flow (categoria, data);

CREATE OR REPLACE FUNCTION fn_cash_flow_imutavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cash_flow é append-only: registre um lançamento de estorno'
    USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER trg_cash_flow_imutavel
  BEFORE UPDATE OR DELETE ON cash_flow
  FOR EACH ROW EXECUTE FUNCTION fn_cash_flow_imutavel();

-- =====================================================================
-- ATTENDANCE  (check-in / check-out)
-- =====================================================================
CREATE TABLE attendance (
  attendance_id   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  check_in        timestamptz NOT NULL DEFAULT now(),
  check_out       timestamptz,
  registrado_por  uuid        REFERENCES users (id) ON DELETE SET NULL, -- [EXT] admin/recepção
  fechado_auto    boolean     NOT NULL DEFAULT false,                    -- [EXT] encerrado pelo job

  CONSTRAINT ck_attendance_periodo CHECK (check_out IS NULL OR check_out > check_in)
);

-- No máximo UMA sessão aberta por aluno (impede check-in duplo, inclusive em race condition).
CREATE UNIQUE INDEX uq_attendance_sessao_aberta ON attendance (user_id) WHERE check_out IS NULL;
CREATE INDEX ix_attendance_presentes            ON attendance (check_in) WHERE check_out IS NULL;
CREATE INDEX ix_attendance_user_checkin         ON attendance (user_id, check_in DESC);
CREATE INDEX ix_attendance_checkin              ON attendance (check_in);

CREATE TRIGGER trg_attendance_role
  BEFORE INSERT OR UPDATE OF user_id ON attendance
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

-- Incrementa total_presencas e publica evento para o painel em tempo real
-- (a API escuta via LISTEN presenca_evento e repassa por SSE).
CREATE OR REPLACE FUNCTION fn_attendance_after_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE aluno_profile
     SET total_presencas = total_presencas + 1
   WHERE user_id = NEW.user_id;

  PERFORM pg_notify('presenca_evento', json_build_object(
    'evento', 'check_in',
    'attendance_id', NEW.attendance_id,
    'user_id', NEW.user_id,
    'em', NEW.check_in
  )::text);
  RETURN NEW;
END $$;

CREATE TRIGGER trg_attendance_after_insert
  AFTER INSERT ON attendance
  FOR EACH ROW EXECUTE FUNCTION fn_attendance_after_insert();

CREATE OR REPLACE FUNCTION fn_attendance_after_checkout() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.check_out IS NULL AND NEW.check_out IS NOT NULL THEN
    PERFORM pg_notify('presenca_evento', json_build_object(
      'evento', 'check_out',
      'attendance_id', NEW.attendance_id,
      'user_id', NEW.user_id,
      'em', NEW.check_out
    )::text);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_attendance_after_checkout
  AFTER UPDATE OF check_out ON attendance
  FOR EACH ROW EXECUTE FUNCTION fn_attendance_after_checkout();

-- =====================================================================
-- REGRAS DE ADIMPLÊNCIA
-- =====================================================================

-- Mensalidades que BLOQUEIAM a carteirinha: não pagas e vencidas há mais
-- de p_dias_carencia dias. Calculado em tempo real (não depende do job).
CREATE OR REPLACE FUNCTION fn_pendencias_bloqueantes(p_user_id uuid, p_dias_carencia int DEFAULT 5)
RETURNS TABLE (payment_id uuid, valor numeric, data_vencimento date, dias_atraso int)
LANGUAGE sql STABLE AS $$
  SELECT f.payment_id,
         f.valor,
         f.data_vencimento,
         (fn_hoje_sp() - f.data_vencimento)::int
    FROM financeiro f
   WHERE f.user_id = p_user_id
     AND f.status <> 'pago'
     AND f.data_vencimento + p_dias_carencia < fn_hoje_sp()
   ORDER BY f.data_vencimento
$$;

-- Recalcula e persiste o status de UM aluno (usado após pagamento e na
-- emissão da carteirinha — "self-healing" entre execuções do job).
CREATE OR REPLACE FUNCTION fn_sincronizar_status_aluno(p_user_id uuid, p_dias_carencia int DEFAULT 5)
RETURNS user_status
LANGUAGE plpgsql AS $$
DECLARE
  v_status user_status;
  v_novo   user_status;
BEGIN
  SELECT status INTO v_status
    FROM users
   WHERE id = p_user_id AND role = 'aluno'
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'aluno % não encontrado', p_user_id USING ERRCODE = 'no_data_found';
  END IF;

  -- Inativo é decisão administrativa; financeiro não o altera.
  IF v_status = 'inativo' THEN
    RETURN v_status;
  END IF;

  UPDATE financeiro
     SET status = 'atrasado'
   WHERE user_id = p_user_id
     AND status = 'pendente'
     AND data_vencimento < fn_hoje_sp();

  v_novo := CASE
              WHEN EXISTS (SELECT 1 FROM fn_pendencias_bloqueantes(p_user_id, p_dias_carencia))
              THEN 'inadimplente'::user_status
              ELSE 'ativo'::user_status
            END;

  IF v_novo IS DISTINCT FROM v_status THEN
    UPDATE users SET status = v_novo WHERE id = p_user_id;
  END IF;

  RETURN v_novo;
END $$;

-- Job diário (Railway Cron): processa todos os alunos de forma set-based.
CREATE OR REPLACE FUNCTION fn_processar_inadimplencia(p_dias_carencia int DEFAULT 5)
RETURNS TABLE (mensalidades_atrasadas int, alunos_bloqueados int, alunos_regularizados int)
LANGUAGE plpgsql AS $$
DECLARE
  v_hoje date := fn_hoje_sp();
  v_a int; v_b int; v_c int;
BEGIN
  UPDATE financeiro
     SET status = 'atrasado'
   WHERE status = 'pendente'
     AND data_vencimento < v_hoje;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  UPDATE users u
     SET status = 'inadimplente'
   WHERE u.role = 'aluno'
     AND u.status = 'ativo'
     AND EXISTS (SELECT 1 FROM financeiro f
                  WHERE f.user_id = u.id
                    AND f.status <> 'pago'
                    AND f.data_vencimento + p_dias_carencia < v_hoje);
  GET DIAGNOSTICS v_b = ROW_COUNT;

  UPDATE users u
     SET status = 'ativo'
   WHERE u.status = 'inadimplente'
     AND NOT EXISTS (SELECT 1 FROM financeiro f
                      WHERE f.user_id = u.id
                        AND f.status <> 'pago'
                        AND f.data_vencimento + p_dias_carencia < v_hoje);
  GET DIAGNOSTICS v_c = ROW_COUNT;

  RETURN QUERY SELECT v_a, v_b, v_c;
END $$;

-- Encerra sessões de presença esquecidas abertas (ex.: > 4h).
CREATE OR REPLACE FUNCTION fn_fechar_presencas_abandonadas(p_horas int DEFAULT 4)
RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_n int;
BEGIN
  UPDATE attendance
     SET check_out = check_in + make_interval(hours => p_horas),
         fechado_auto = true
   WHERE check_out IS NULL
     AND check_in < now() - make_interval(hours => p_horas);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $$;

-- =====================================================================
-- RELATÓRIOS
-- =====================================================================

-- Balanço diário do caixa (dia civil em America/Sao_Paulo, usa ix_cash_flow_data).
CREATE OR REPLACE FUNCTION fn_balanco_diario(p_dia date)
RETURNS TABLE (
  dia                   date,
  entradas_mensalidade  numeric,
  entradas_loja         numeric,
  entradas_outros       numeric,
  total_entradas        numeric,
  sangrias              numeric,
  saidas_outros         numeric,
  total_saidas          numeric,
  saldo                 numeric,
  qtd_lancamentos       int
)
LANGUAGE sql STABLE AS $$
  SELECT p_dia,
         coalesce(sum(cf.valor) FILTER (WHERE cf.categoria = 'mensalidade'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.categoria = 'loja'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.categoria = 'outros' AND cf.tipo = 'entrada'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.tipo = 'entrada'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.categoria = 'sangria'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.categoria = 'outros' AND cf.tipo = 'saida'), 0),
         coalesce(sum(cf.valor) FILTER (WHERE cf.tipo = 'saida'), 0),
         coalesce(sum(CASE WHEN cf.tipo = 'entrada' THEN cf.valor ELSE -cf.valor END), 0),
         count(*)::int
    FROM cash_flow cf
   WHERE cf.data >= (p_dia::timestamp       AT TIME ZONE 'America/Sao_Paulo')
     AND cf.data <  ((p_dia + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
$$;

-- Alunos presentes agora (painel da recepção).
CREATE OR REPLACE VIEW vw_presentes_agora AS
SELECT a.attendance_id,
       a.user_id,
       u.nome,
       p.modalidade,
       p.faixa,
       p.graduacao_nivel,
       a.check_in,
       now() - a.check_in AS tempo_no_tatame
  FROM attendance a
  JOIN users u         ON u.id = a.user_id
  JOIN aluno_profile p ON p.user_id = a.user_id
 WHERE a.check_out IS NULL;

COMMIT;
