-- =====================================================================
-- 0009 — Loja: catálogo para o aluno e pedidos de intenção (WhatsApp)
--
-- O catálogo do aluno É a tabela de produtos do gestor (inventory_product):
-- um só cadastro e um só estoque. O que a especificação chamou de
-- "produtos_loja" é exposto pela API como GET /loja/produtos com os campos
-- id, nome, descricao, preco, imagem_url, estoque (ativo = true).
--
--   * inventory_product.descricao / imagem_url  — novos, anuláveis
--   * produto_imagens  — bytes da foto do produto (fora do catálogo, para a
--     listagem não carregar imagem); 1 imagem vigente por produto
--   * pedidos_loja     — intenção de compra do aluno. NÃO baixa estoque nem
--     mexe no caixa: a venda continua sendo registrada no balcão (loja_venda)
-- =====================================================================

ALTER TABLE inventory_product
  ADD COLUMN descricao  text,
  ADD COLUMN imagem_url varchar(300),
  ADD CONSTRAINT ck_product_descricao CHECK (descricao IS NULL OR length(descricao) <= 2000),
  ADD CONSTRAINT ck_product_imagem_url CHECK (
    imagem_url IS NULL
    OR imagem_url ~ '^/api/v1/loja/imagens/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );

CREATE TABLE produto_imagens (
  id          uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  uuid         NOT NULL REFERENCES inventory_product (product_id) ON DELETE CASCADE,
  mime        varchar(20)  NOT NULL,
  dados       bytea        NOT NULL,
  created_at  timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ck_produto_imagem_mime    CHECK (mime IN ('image/webp', 'image/jpeg')),
  CONSTRAINT ck_produto_imagem_tamanho CHECK (octet_length(dados) BETWEEN 100 AND 524288)
);
CREATE UNIQUE INDEX uq_produto_imagens_product ON produto_imagens (product_id);

CREATE TYPE pedido_loja_status AS ENUM ('solicitado', 'atendido', 'cancelado');

CREATE TABLE pedidos_loja (
  id              uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid                NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  product_id      uuid                NOT NULL REFERENCES inventory_product (product_id) ON DELETE RESTRICT,
  quantidade      integer             NOT NULL DEFAULT 1,
  -- snapshot: o gestor vê o preço que o aluno viu no catálogo
  preco_unitario  numeric(10, 2)      NOT NULL,
  status          pedido_loja_status  NOT NULL DEFAULT 'solicitado',
  atendido_por    uuid                REFERENCES users (id) ON DELETE SET NULL,
  atendido_em     timestamptz,
  created_at      timestamptz         NOT NULL DEFAULT now(),

  CONSTRAINT ck_pedido_quantidade CHECK (quantidade BETWEEN 1 AND 10),
  CONSTRAINT ck_pedido_preco      CHECK (preco_unitario >= 0),
  CONSTRAINT ck_pedido_conclusao  CHECK ((status = 'solicitado') = (atendido_em IS NULL))
);
-- Um pedido em aberto por aluno e produto: clicar de novo reaproveita o mesmo.
CREATE UNIQUE INDEX uq_pedido_aberto ON pedidos_loja (user_id, product_id) WHERE status = 'solicitado';
CREATE INDEX ix_pedidos_loja_status ON pedidos_loja (status, created_at DESC);

-- Só aluno faz pedido (mesma regra de loja_venda).
CREATE TRIGGER trg_pedido_loja_role
  BEFORE INSERT OR UPDATE OF user_id ON pedidos_loja
  FOR EACH ROW EXECUTE FUNCTION fn_assert_role_aluno();

-- LOJA-02 (defesa em profundidade): a foto de perfil da 0008 aceitava qualquer
-- https:// "para um storage futuro". Enquanto não houver storage externo
-- aprovado, só o caminho interno vale — um link externo em <img> revelaria
-- IP/user-agent dos alunos e da equipe a terceiros. A API nunca gravou https://.
ALTER TABLE aluno_profile
  DROP CONSTRAINT ck_aluno_foto_url,
  ADD CONSTRAINT ck_aluno_foto_url CHECK (
    foto_url IS NULL
    OR foto_url ~ '^/api/v1/fotos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
