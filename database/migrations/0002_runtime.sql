-- Additive extensions to system_contract v1.0.
ALTER TABLE refresh_tokens ADD COLUMN family_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE INDEX ix_refresh_family ON refresh_tokens(family_id);
CREATE TABLE api_rate_limits (
  key text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL
);
CREATE TABLE idempotency_keys (
  actor_id uuid NOT NULL REFERENCES users(id), key varchar(128) NOT NULL,
  request_hash char(64) NOT NULL, response jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY(actor_id,key)
);
CREATE TABLE inventory_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES inventory_product(product_id),
  operacao text NOT NULL CHECK(operacao IN ('entrada','ajuste')),
  quantidade integer NOT NULL, estoque_anterior integer NOT NULL,
  estoque_novo integer NOT NULL CHECK(estoque_novo >= 0), motivo varchar(255) NOT NULL,
  registrado_por uuid NOT NULL REFERENCES users(id), data timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_inventory_movements_product ON inventory_movements(product_id,data);
CREATE INDEX ix_refresh_expiration ON refresh_tokens(expires_at);
CREATE INDEX ix_idempotency_expiration ON idempotency_keys(expires_at);
-- Money inside json/jsonb must explicitly be text, otherwise pg returns JS floats.
CREATE INDEX ix_cash_flow_type_data ON cash_flow(tipo,data);
