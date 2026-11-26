-- =====================================================================
-- 0010 — Turmas e chamada por turma
--
--   turmas        (Class)        nome, horário, modalidade, professor
--   turma_alunos  (ClassMember)  quem pertence a qual turma (N:N)
--   attendance.turma_id          presença registrada pela chamada da turma
--
-- A chamada NÃO cria um modelo novo de presença: grava em attendance (a mesma
-- tabela do check-in por QR/recepção), marcando a turma. Falta = ausência de
-- registro. Turma não é apagada: desativa (ativa = false) e o histórico de
-- presença continua apontando para ela.
-- =====================================================================

CREATE TABLE turmas (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  nome          varchar(80)  NOT NULL,
  -- texto livre exibido na chamada, ex.: "Seg, Qua e Sex · 19h"
  horario       varchar(80),
  modalidade    modalidade,
  professor_id  uuid         REFERENCES users (id) ON DELETE RESTRICT,
  ativa         boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ck_turma_nome    CHECK (length(btrim(nome)) >= 2),
  CONSTRAINT ck_turma_horario CHECK (horario IS NULL OR length(btrim(horario)) >= 1)
);

-- Duas turmas ativas com o mesmo nome confundiriam a chamada.
CREATE UNIQUE INDEX uq_turmas_nome_ativa ON turmas (lower(btrim(nome))) WHERE ativa;

CREATE TRIGGER trg_turmas_updated_at
  BEFORE UPDATE ON turmas
  FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Responsável pela turma: professor ou gestor (nunca aluno).
CREATE OR REPLACE FUNCTION fn_turma_professor_valido() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.professor_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM users WHERE id = NEW.professor_id AND role IN ('professor', 'admin')) THEN
    RAISE EXCEPTION 'professor_id % não é professor nem gestor', NEW.professor_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_turma_professor';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_turmas_professor
  BEFORE INSERT OR UPDATE OF professor_id ON turmas
  FOR EACH ROW EXECUTE FUNCTION fn_turma_professor_valido();

CREATE TABLE turma_alunos (
  turma_id       uuid         NOT NULL REFERENCES turmas (id) ON DELETE CASCADE,
  user_id        uuid         NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  adicionado_em  timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (turma_id, user_id)
);

CREATE INDEX ix_turma_alunos_user ON turma_alunos (user_id);

-- Só alunos entram em turma (mesma função usada por attendance/aluno_profile).
CREATE TRIGGER trg_turma_alunos_role
  BEFORE INSERT OR UPDATE OF user_id ON turma_alunos
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

-- Presença registrada pela chamada: qual turma. NULL = check-in avulso
-- (QR/recepção). Turma desativada continua referenciada; nunca é apagada pela API.
ALTER TABLE attendance
  ADD COLUMN turma_id uuid REFERENCES turmas (id) ON DELETE SET NULL;

CREATE INDEX ix_attendance_turma_checkin ON attendance (turma_id, check_in)
  WHERE turma_id IS NOT NULL;
