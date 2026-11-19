-- =====================================================================
-- 0004 — Novos valores de enum
-- Isolada da 0005: o PostgreSQL não permite USAR um valor de enum na mesma
-- transação em que ele foi criado (cada migração roda em uma transação).
-- =====================================================================

-- Papel docente: cadastra/consulta alunos, gradua e faz check-in.
-- NÃO acessa financeiro, caixa, loja nem dashboard (ver apps/api/src/http.ts: STAFF).
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'professor';

ALTER TYPE modalidade ADD VALUE IF NOT EXISTS 'mma';
