-- =====================================================================
-- 0006 — Ajustes da ficha do professor (incremental sobre a 0005 publicada)
--   * Contato de emergência OBRIGATÓRIO para todo aluno (ficha §4) — BLK-02
--   * Autorizações de uso de imagem e de grupo de WhatsApp (ficha §5)
--   * Nível por modalidade:
--       jiu_jitsu        → faixa + grau (graduacao_nivel); nivel = NULL
--       boxe/muay_thai/mma → nivel ∈ {iniciante, intermediario, avancado};
--                          faixa espelha o rótulo do nível; grau = 0
--   * Data de matrícula: nem futura nem anterior ao nascimento
--
-- Alunos já existentes não têm contato de emergência real para backfill
-- (inventar dado seria pior). Eles ficam com ficha_pendente = true e só
-- saem desse estado quando a ficha for completada. Linhas novas nunca
-- nascem pendentes, e uma ficha completa nunca volta a ficar pendente.
-- =====================================================================

CREATE TYPE nivel_tecnico AS ENUM ('iniciante', 'intermediario', 'avancado');

CREATE OR REPLACE FUNCTION fn_nivel_rotulo(p nivel_tecnico) RETURNS varchar
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p
    WHEN 'iniciante'     THEN 'Iniciante'
    WHEN 'intermediario' THEN 'Intermediário'
    WHEN 'avancado'      THEN 'Avançado'
  END
$$;

ALTER TABLE aluno_profile
  ADD COLUMN nivel                          nivel_tecnico,
  ADD COLUMN contato_emergencia_nome        varchar(120),
  ADD COLUMN contato_emergencia_parentesco  varchar(40),
  ADD COLUMN contato_emergencia_telefone    varchar(15),
  ADD COLUMN contato_emergencia_telefone2   varchar(15),
  ADD COLUMN autoriza_uso_imagem            boolean,
  ADD COLUMN autoriza_grupo_whatsapp        boolean,
  ADD COLUMN ficha_pendente                 boolean NOT NULL DEFAULT false;

-- Legado: todo perfil anterior a esta migração fica pendente de completar.
UPDATE aluno_profile SET ficha_pendente = true;

-- ---------------------------------------------------------------------
-- Regras declarativas (CHECK). A exceção é só a marca de legado.
-- ---------------------------------------------------------------------
ALTER TABLE aluno_profile
  -- BLK-02: contato de emergência obrigatório (nome, parentesco, telefone 1)
  ADD CONSTRAINT ck_aluno_emergencia_obrigatoria CHECK (
    ficha_pendente
    OR (contato_emergencia_nome IS NOT NULL
        AND length(btrim(contato_emergencia_nome)) >= 2
        AND contato_emergencia_parentesco IS NOT NULL
        AND length(btrim(contato_emergencia_parentesco)) >= 1
        AND contato_emergencia_telefone IS NOT NULL)
  ),
  ADD CONSTRAINT ck_aluno_emergencia_telefones CHECK (
    (contato_emergencia_telefone  IS NULL OR contato_emergencia_telefone  ~ '^[1-9]\d{9,14}$')
    AND (contato_emergencia_telefone2 IS NULL OR contato_emergencia_telefone2 ~ '^[1-9]\d{9,14}$')
    AND (contato_emergencia_telefone2 IS NULL OR contato_emergencia_telefone IS NOT NULL)
  ),
  -- Nível conforme a modalidade
  ADD CONSTRAINT ck_aluno_nivel_modalidade CHECK (
    ficha_pendente
    OR CASE WHEN modalidade = 'jiu_jitsu'
            THEN nivel IS NULL
            ELSE nivel IS NOT NULL AND graduacao_nivel = 0
       END
  ),
  -- Termo aceito ⇒ as duas autorizações foram respondidas (sim ou não)
  ADD CONSTRAINT ck_aluno_autorizacoes CHECK (
    ficha_pendente
    OR NOT termos_aceitos
    OR (autoriza_uso_imagem IS NOT NULL AND autoriza_grupo_whatsapp IS NOT NULL)
  );

CREATE INDEX ix_aluno_ficha_pendente ON aluno_profile (user_id) WHERE ficha_pendente;

-- ---------------------------------------------------------------------
-- Trigger: marca de legado, espelho do nível em `faixa` e datas.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_aluno_ficha_professor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Fora do Jiu-Jitsu a `faixa` exibida é o rótulo do nível (listas e
  -- carteirinha continuam lendo `faixa`).
  IF NEW.modalidade <> 'jiu_jitsu' AND NEW.nivel IS NOT NULL THEN
    NEW.faixa := fn_nivel_rotulo(NEW.nivel);
  END IF;

  -- Pendência só existe para linhas legadas e some ao completar a ficha.
  IF TG_OP = 'INSERT' OR NOT OLD.ficha_pendente THEN
    NEW.ficha_pendente := false;
  ELSIF NEW.contato_emergencia_nome IS NOT NULL
        AND NEW.contato_emergencia_parentesco IS NOT NULL
        AND NEW.contato_emergencia_telefone IS NOT NULL
        AND (CASE WHEN NEW.modalidade = 'jiu_jitsu' THEN NEW.nivel IS NULL
                  ELSE NEW.nivel IS NOT NULL AND NEW.graduacao_nivel = 0 END)
        AND (NOT NEW.termos_aceitos
             OR (NEW.autoriza_uso_imagem IS NOT NULL AND NEW.autoriza_grupo_whatsapp IS NOT NULL)) THEN
    NEW.ficha_pendente := false;
  END IF;

  -- Datas: checadas na criação e quando mudam (não em updates de contadores,
  -- para não travar check-in de alunos legados).
  IF TG_OP = 'INSERT'
     OR NEW.data_matricula IS DISTINCT FROM OLD.data_matricula
     OR NEW.data_nascimento IS DISTINCT FROM OLD.data_nascimento THEN
    IF NEW.data_matricula > fn_hoje_sp() THEN
      RAISE EXCEPTION 'Data de matrícula no futuro'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_aluno_matricula';
    END IF;
    IF NEW.data_matricula < NEW.data_nascimento THEN
      RAISE EXCEPTION 'Data de matrícula anterior ao nascimento'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_aluno_matricula';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_aluno_ficha_professor
  BEFORE INSERT OR UPDATE ON aluno_profile
  FOR EACH ROW EXECUTE FUNCTION fn_aluno_ficha_professor();

-- ---------------------------------------------------------------------
-- Telefone de emergência: o do aluno; se não houver, o do responsável.
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW vw_contato_aluno AS
SELECT p.user_id,
       coalesce(p.whatsapp, r.whatsapp) AS whatsapp,
       CASE
         WHEN p.whatsapp IS NOT NULL THEN 'aluno'
         WHEN r.whatsapp IS NOT NULL THEN 'responsavel'
       END AS origem,
       coalesce(p.contato_emergencia_telefone, r.telefone_emergencia) AS telefone_emergencia
  FROM aluno_profile p
  LEFT JOIN responsaveis r ON r.id = p.responsavel_id;
