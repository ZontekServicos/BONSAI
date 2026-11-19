-- =====================================================================
-- 0005 — Cadastro completo do aluno (Fase 1)
--   * responsaveis       (Guardian)  — 1 responsável : N alunos (irmãos)
--   * aluno_profile      (Student)   — dados pessoais, contato, termos
--   * historico_saude    (HealthHistory) — 1:1 com o aluno
-- Regras garantidas pelo banco (última linha de defesa; a API valida antes):
--   * menor de 18 anos  ⇒ responsavel_id obrigatório
--   * CPF válido (dígitos verificadores) e único
--   * contato principal = WhatsApp do aluno, senão o do responsável
-- Dados de saúde são dados pessoais SENSÍVEIS (LGPD art. 11) e de menores
-- exigem consentimento do responsável (art. 14): nunca entram em listagens.
-- =====================================================================

CREATE TYPE genero AS ENUM ('masculino', 'feminino', 'outro');

-- Valida CPF pelos dígitos verificadores (recebe só dígitos).
CREATE OR REPLACE FUNCTION fn_cpf_valido(p_cpf text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s int;
  d1 int;
  d2 int;
BEGIN
  IF p_cpf !~ '^\d{11}$' OR p_cpf ~ '^(\d)\1{10}$' THEN
    RETURN false;
  END IF;
  s := 0;
  FOR i IN 1..9 LOOP s := s + substr(p_cpf, i, 1)::int * (11 - i); END LOOP;
  d1 := (s * 10) % 11; IF d1 = 10 THEN d1 := 0; END IF;
  s := 0;
  FOR i IN 1..10 LOOP s := s + substr(p_cpf, i, 1)::int * (12 - i); END LOOP;
  d2 := (s * 10) % 11; IF d2 = 10 THEN d2 := 0; END IF;
  RETURN d1 = substr(p_cpf, 10, 1)::int AND d2 = substr(p_cpf, 11, 1)::int;
END $$;

-- ---------------------------------------------------------------------
-- RESPONSÁVEIS
-- Telefones em dígitos no formato E.164 sem "+" (ex.: 5511987654321).
-- ---------------------------------------------------------------------
CREATE TABLE responsaveis (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  nome                 varchar(120) NOT NULL,
  parentesco           varchar(10)  NOT NULL,
  whatsapp             varchar(15)  NOT NULL,
  telefone_emergencia  varchar(15)  NOT NULL,
  email                citext,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ck_responsavel_nome       CHECK (length(btrim(nome)) >= 2),
  CONSTRAINT ck_responsavel_parentesco CHECK (parentesco IN ('pai', 'mae', 'tutor', 'outro')),
  CONSTRAINT ck_responsavel_whatsapp   CHECK (whatsapp ~ '^[1-9]\d{9,14}$'),
  CONSTRAINT ck_responsavel_emergencia CHECK (telefone_emergencia ~ '^[1-9]\d{9,14}$'),
  CONSTRAINT ck_responsavel_email      CHECK (email IS NULL OR email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE INDEX ix_responsaveis_nome_search ON responsaveis USING gin (nome gin_trgm_ops);
CREATE INDEX ix_responsaveis_whatsapp    ON responsaveis (whatsapp);

CREATE TRIGGER trg_responsaveis_updated_at
  BEFORE UPDATE ON responsaveis
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------
-- ALUNO (aluno_profile ← Student)
-- Colunas anuláveis só para não quebrar alunos já existentes; a rota de
-- cadastro (POST /alunos/cadastro) exige todos os campos obrigatórios.
-- ---------------------------------------------------------------------
ALTER TABLE aluno_profile
  ADD COLUMN genero                genero,
  ADD COLUMN rg                    varchar(20),
  ADD COLUMN cpf                   char(11),
  ADD COLUMN data_nascimento       date,
  ADD COLUMN endereco              varchar(200),
  ADD COLUMN bairro                varchar(80),
  ADD COLUMN cidade                varchar(80),
  ADD COLUMN cep                   char(8),
  ADD COLUMN whatsapp              varchar(15),
  ADD COLUMN professor_responsavel varchar(120),
  ADD COLUMN responsavel_id        uuid REFERENCES responsaveis (id) ON DELETE RESTRICT,
  ADD COLUMN termos_aceitos        boolean NOT NULL DEFAULT false,
  ADD COLUMN termos_aceitos_em     timestamptz,
  ADD COLUMN termos_versao         varchar(20),
  ADD CONSTRAINT ck_aluno_cpf        CHECK (cpf IS NULL OR fn_cpf_valido(cpf)),
  ADD CONSTRAINT ck_aluno_cep        CHECK (cep IS NULL OR cep ~ '^\d{8}$'),
  ADD CONSTRAINT ck_aluno_whatsapp   CHECK (whatsapp IS NULL OR whatsapp ~ '^[1-9]\d{9,14}$'),
  ADD CONSTRAINT ck_aluno_nascimento CHECK (data_nascimento IS NULL OR data_nascimento >= DATE '1900-01-01'),
  -- aceite ⇔ data e versão do termo preenchidas
  ADD CONSTRAINT ck_aluno_termos CHECK (
    termos_aceitos = (termos_aceitos_em IS NOT NULL)
    AND (termos_aceitos_em IS NULL) = (termos_versao IS NULL)
  );

CREATE UNIQUE INDEX uq_aluno_cpf      ON aluno_profile (cpf) WHERE cpf IS NOT NULL;
CREATE INDEX ix_aluno_responsavel     ON aluno_profile (responsavel_id) WHERE responsavel_id IS NOT NULL;

-- Menor de 18 anos (na data de hoje em São Paulo) exige responsável.
-- Trigger, e não CHECK, porque depende da data atual (não-imutável).
CREATE OR REPLACE FUNCTION fn_aluno_menor_exige_responsavel() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.data_nascimento IS NOT NULL
     AND NEW.data_nascimento > (fn_hoje_sp() - interval '18 years')::date
     AND NEW.responsavel_id IS NULL THEN
    RAISE EXCEPTION 'Aluno menor de 18 anos exige responsável (user_id %)', NEW.user_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_aluno_menor_responsavel';
  END IF;
  IF NEW.data_nascimento > fn_hoje_sp() THEN
    RAISE EXCEPTION 'Data de nascimento no futuro'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_aluno_nascimento';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_aluno_menor_exige_responsavel
  BEFORE INSERT OR UPDATE OF data_nascimento, responsavel_id ON aluno_profile
  FOR EACH ROW EXECUTE FUNCTION fn_aluno_menor_exige_responsavel();

-- ---------------------------------------------------------------------
-- HISTÓRICO DE SAÚDE (1:1)
-- ---------------------------------------------------------------------
CREATE TABLE historico_saude (
  user_id                    uuid        PRIMARY KEY REFERENCES aluno_profile (user_id) ON DELETE CASCADE,
  tipo_sanguineo             varchar(3),
  condicoes_medicas          text,  -- alergias, asma, cardiopatias…
  lesoes_cronicas            text,  -- joelho, ombro, coluna…
  medicacao_continua         text,
  artes_marciais_anteriores  text,
  atualizado_por             uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_saude_tipo_sanguineo CHECK (
    tipo_sanguineo IS NULL OR tipo_sanguineo IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')
  ),
  CONSTRAINT ck_saude_tamanho CHECK (
    coalesce(length(condicoes_medicas), 0) <= 2000
    AND coalesce(length(lesoes_cronicas), 0) <= 2000
    AND coalesce(length(medicacao_continua), 0) <= 2000
    AND coalesce(length(artes_marciais_anteriores), 0) <= 2000
  )
);

CREATE TRIGGER trg_historico_saude_updated_at
  BEFORE UPDATE ON historico_saude
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- ---------------------------------------------------------------------
-- CONTATO PRINCIPAL (regra de notificação)
-- WhatsApp do aluno; se não houver, o do responsável. Base da Fase 4.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_contato_aluno AS
SELECT p.user_id,
       coalesce(p.whatsapp, r.whatsapp) AS whatsapp,
       CASE
         WHEN p.whatsapp IS NOT NULL THEN 'aluno'
         WHEN r.whatsapp IS NOT NULL THEN 'responsavel'
       END AS origem,
       r.telefone_emergencia
  FROM aluno_profile p
  LEFT JOIN responsaveis r ON r.id = p.responsavel_id;
