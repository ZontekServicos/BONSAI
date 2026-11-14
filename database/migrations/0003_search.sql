-- Substring search used by the reception and student selector.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX ix_users_nome_search ON users USING gin(nome gin_trgm_ops);
CREATE INDEX ix_users_email_search ON users USING gin((email::text) gin_trgm_ops);
