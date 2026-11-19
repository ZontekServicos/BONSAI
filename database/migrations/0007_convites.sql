-- =====================================================================
-- 0007 — Convites de cadastro
-- Professor/gestor gera um link com token → o aluno abre o link e preenche
-- a ficha completa sozinho (sem conta prévia). Sem token válido, não há
-- cadastro público.
--
-- Segurança:
--   * O token (256 bits aleatórios) NUNCA é gravado: só o SHA-256 dele.
--     Quem lê o banco (backup, log, réplica) não consegue usar os links.
--   * O e-mail do convite vira o e-mail da conta: o link só cadastra a
--     pessoa convidada.
--   * Uso único: o convite é consumido na MESMA transação que cria o aluno.
--     Estados finais (utilizado/revogado) não podem ser desfeitos.
--   * No máximo um convite em aberto por e-mail (um novo revoga o anterior).
--
-- Saúde e menores de idade já estão no banco desde a 0005/0006
-- (historico_saude e trigger de menoridade); o fluxo por convite usa as
-- mesmas tabelas e as mesmas regras.
-- =====================================================================

CREATE TABLE convites (
  id                     uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash             char(64)     NOT NULL,
  email_destinatario     citext       NOT NULL,
  whatsapp_destinatario  varchar(15),
  data_expiracao         timestamptz  NOT NULL,
  utilizado              boolean      NOT NULL DEFAULT false,
  utilizado_em           timestamptz,
  aluno_id               uuid         REFERENCES users (id) ON DELETE SET NULL,
  revogado_em            timestamptz,
  criado_por             uuid         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at             timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT uq_convites_token     UNIQUE (token_hash),
  CONSTRAINT ck_convite_token      CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_convite_email      CHECK (email_destinatario ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  CONSTRAINT ck_convite_whatsapp   CHECK (whatsapp_destinatario IS NULL OR whatsapp_destinatario ~ '^[1-9]\d{9,14}$'),
  -- validade entre "agora" e 30 dias (padrão da API: 7 dias)
  CONSTRAINT ck_convite_validade   CHECK (data_expiracao > created_at
                                          AND data_expiracao <= created_at + interval '30 days'),
  CONSTRAINT ck_convite_utilizado  CHECK (utilizado = (utilizado_em IS NOT NULL)),
  CONSTRAINT ck_convite_final      CHECK (NOT (utilizado AND revogado_em IS NOT NULL))
);

-- Um convite em aberto por e-mail (expirados também contam até serem revogados;
-- a API revoga os anteriores ao gerar um novo).
CREATE UNIQUE INDEX uq_convite_aberto_por_email
  ON convites (email_destinatario) WHERE NOT utilizado AND revogado_em IS NULL;
CREATE INDEX ix_convites_recentes ON convites (created_at DESC, id);

-- Estados finais são imutáveis: um link usado ou revogado nunca volta a valer.
CREATE OR REPLACE FUNCTION fn_convite_estado_final() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.utilizado OR OLD.revogado_em IS NOT NULL THEN
    RAISE EXCEPTION 'Convite já utilizado ou revogado (id %)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_convite_final';
  END IF;
  IF NEW.token_hash <> OLD.token_hash
     OR NEW.email_destinatario <> OLD.email_destinatario
     OR NEW.criado_por <> OLD.criado_por
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Dados de origem do convite não podem ser alterados'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_convite_final';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_convite_estado_final
  BEFORE UPDATE ON convites
  FOR EACH ROW EXECUTE FUNCTION fn_convite_estado_final();
