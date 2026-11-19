-- =====================================================================
-- 0008 — Perfil editável pelo aluno: foto, altura e peso
--   * aluno_profile.foto_url  → link da foto (hoje /api/v1/fotos/<id>;
--     aceita https:// para um storage externo no futuro, sem mudar schema)
--   * aluno_profile.altura    → metros, 2 casas (ex.: 1.85)
--   * aluno_profile.peso      → kg, 2 casas (ex.: 82.50)
--   * aluno_profile.medidas_atualizadas_em → "quando pesou pela última vez"
--   * fotos                   → bytes da imagem, FORA do aluno_profile:
--     listagens nunca carregam imagem; 1 foto vigente por usuário.
-- O app reduz a foto para 512 px (≈40 KB) e remove metadados (EXIF/GPS)
-- antes de enviar; o banco limita o tamanho e o formato.
-- =====================================================================

CREATE TABLE fotos (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  mime        varchar(20)  NOT NULL,
  dados       bytea        NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ck_foto_mime    CHECK (mime IN ('image/webp', 'image/jpeg')),
  CONSTRAINT ck_foto_tamanho CHECK (octet_length(dados) BETWEEN 100 AND 524288)
);
-- Uma foto vigente por usuário (a troca apaga a anterior na mesma transação).
CREATE UNIQUE INDEX uq_fotos_user ON fotos (user_id);

ALTER TABLE aluno_profile
  ADD COLUMN foto_url                varchar(300),
  ADD COLUMN altura                  numeric(3, 2),
  ADD COLUMN peso                    numeric(5, 2),
  ADD COLUMN medidas_atualizadas_em  timestamptz,
  ADD CONSTRAINT ck_aluno_foto_url CHECK (
    foto_url IS NULL
    OR foto_url ~ '^/api/v1/fotos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR foto_url ~ '^https://[^\s]+$'
  ),
  ADD CONSTRAINT ck_aluno_altura CHECK (altura IS NULL OR altura BETWEEN 0.50 AND 2.50),
  ADD CONSTRAINT ck_aluno_peso   CHECK (peso IS NULL OR peso BETWEEN 10 AND 300);

-- Altura/peso mudaram ⇒ registra quando. A API também renova a data quando o
-- aluno confirma as mesmas medidas (pesou de novo e deu igual).
CREATE OR REPLACE FUNCTION fn_aluno_medidas_atualizadas() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.altura IS DISTINCT FROM OLD.altura OR NEW.peso IS DISTINCT FROM OLD.peso)
     AND NEW.medidas_atualizadas_em IS NOT DISTINCT FROM OLD.medidas_atualizadas_em THEN
    NEW.medidas_atualizadas_em := now();
  END IF;
  IF NEW.medidas_atualizadas_em > now() THEN
    RAISE EXCEPTION 'Data das medidas no futuro'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'ck_aluno_medidas_data';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_aluno_medidas_atualizadas
  BEFORE UPDATE OF altura, peso, medidas_atualizadas_em ON aluno_profile
  FOR EACH ROW EXECUTE FUNCTION fn_aluno_medidas_atualizadas();
