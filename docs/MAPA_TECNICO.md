# BONSAI ERP — Mapa técnico

> Snapshot de **19/11/2026** · `main` @ `d8dcd5e` + **Fase 1 do cadastro de alunos** (ainda não commitada) · repositório `ZontekServicos/BONSAI`.
> Fonte: leitura direta do código neste commit. Em caso de divergência, o código vence.

## 1. Identidade

| Campo              | Valor                                                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Produto            | ERP para academia de artes marciais (Boxe, Jiu-Jitsu, Muay Thai)                                                      |
| Marca              | BONSAI — Jiu Jitsu Fight (marca anterior "Fight Control" foi removida)                                                |
| Usuários           | `admin` (gestão, inclui autoridade financeira), `professor` (alunos, graduações, presença — sem financeiro) e `aluno` |
| Idioma             | pt-BR · moeda BRL · fuso de negócio `America/Sao_Paulo`                                                               |
| Hospedagem         | Railway (Docker, um serviço web+API, um serviço cron, Postgres)                                                       |
| Origem do scaffold | Figma Make (Vite + React + Tailwind)                                                                                  |

## 2. Stack

| Camada    | Tecnologia                                                                         |
| --------- | ---------------------------------------------------------------------------------- |
| Front-end | React 19, Vite 8, Tailwind CSS 4 (`@tailwindcss/vite`), lucide-react, qrcode.react |
| Back-end  | Node 22, Fastify 5, Zod 4, `pg` (SQL direto, sem ORM), jose (JWT), @node-rs/argon2 |
| Banco     | PostgreSQL 18 (extensões: citext, pgcrypto, pg_trgm)                               |
| Testes    | Vitest 5 (integração contra Postgres real, banco `bonsai_test`)                    |
| Build     | `vite build` (web) + tsup (API → `apps/api/dist`)                                  |
| Toolchain | pnpm 10.34.3, TypeScript 5.7, oxfmt (formatação)                                   |

## 3. Topologia de execução

```
Navegador ──HTTPS──► Railway "web" (Dockerfile)
                      node apps/api/dist/server.js  (SERVE_WEB=true)
                      ├─ /api/v1/*  → Fastify (API)
                      ├─ /health    → healthcheck (SELECT 1)
                      └─ /*         → dist/ (SPA React, mesma origem)
                             │ rede privada
                             ▼
                      Postgres ◄── LISTEN presenca_evento (SSE)
                             ▲
Railway "cron" (railway.cron.json) node apps/api/dist/jobs/diario.js · 0 6 * * * (03:00 BRT)
```

- Mesma origem: o front chama `/api/v1` (ou `VITE_API_URL`, se definido no build).
- Pre-deploy (`railway.json`): `node apps/api/dist/migrate.js`.
- Desenvolvimento: Vite em `:8443` faz proxy de `/api` para `:3001` (`pnpm dev` + `pnpm dev:api`).

## 4. Mapa do repositório

```
apps/api/src/
  server.ts            bootstrap (readConfig → createDatabase → buildApp → listen 0.0.0.0)
  app.ts               Fastify: CORS, helmet/CSP, cookie, hook de rate-limit, error handler, /health, static
  config.ts            schema Zod das variáveis de ambiente (falha no boot se inválidas)
  db.ts                pool pg, helpers one()/transaction(), userColumns
  http.ts              route() = registro tipado + RBAC + validação Zod; selfOrAdmin(); paginate()
  auth.ts              login/refresh/logout/me/senha, Argon2id, JWT, refresh rotativo, rate limit
  stream.ts            SSE /presencas/stream (LISTEN presenca_evento, heartbeat)
  modules/alunos.ts    alunos, perfil, graduações, área /me
  modules/attendance.ts carteirinha (QR JWT), validação, check-in/out, presença
  modules/billing.ts   mensalidades, pagamento, inadimplência, resumo
  modules/store.ts     produtos, estoque, vendas (idempotentes)
  modules/reports.ts   caixa (sangria/lançamentos/balanço) e dashboard
  modules/cadastro.ts  cadastro completo (responsável→aluno→saúde), ficha, responsáveis, equipe (professores)
  jobs/diario.ts, jobs/service.ts   job diário
  migrate.ts           aplica migrações com advisory lock + checksum
  bootstrap-admin.ts   cria o 1º admin (JSON via stdin)
  seed-demo.ts         contas demo (só dev; recusa NODE_ENV=production; fora do build)
apps/api/test/integration.test.ts   21 testes de integração
database/schema.sql + migrations/0002_runtime.sql + 0003_search.sql
src/                   front-end (ver §8)
src/lib/cadastro.ts    schemas Zod do cadastro, COMPARTILHADOS entre API e front (CPF, idade, telefones)
contracts/system-contract.json      contrato de dados v1.0 (origem do modelo)
scripts/check-colors.mjs            lint da paleta (pnpm lint:colors)
scripts/query-audit.mjs             auditoria de queries (pnpm audit:queries)
docs/                  ARQUITETURA, OPERACAO, AUDITORIA, CODEX_SECURITY*, este mapa
Dockerfile · railway.json · railway.cron.json · .github/workflows/ci.yml
```

## 5. Modelo de dados

Migrações em ordem, registradas em `schema_migrations` (nome + SHA-256; alterar uma migração já aplicada **aborta** o deploy):

1. `database/schema.sql` — modelo base
2. `database/migrations/0002_runtime.sql` — `refresh_tokens.family_id`, `api_rate_limits`, `idempotency_keys`, `inventory_movements`, índices
3. `database/migrations/0003_search.sql` — `pg_trgm` + índices GIN de busca em `users.nome`/`email`
4. `database/migrations/0004_papeis_modalidades.sql` — `user_role += professor`, `modalidade += mma` (isolada: valor novo de enum não pode ser usado na mesma transação)
5. `database/migrations/0005_cadastro_aluno.sql` — `responsaveis`, `historico_saude`, dados pessoais em `aluno_profile`, `fn_cpf_valido`, trigger de menoridade, `vw_contato_aluno` (**publicada em `54e215e`; imutável** — checksum `0d4d147d…`, protegido por teste)
6. `database/migrations/0006_ajustes_ficha_professor.sql` — ficha do professor: contato de emergência **obrigatório** (BLK-02), autorizações de imagem/grupo de WhatsApp, `nivel_tecnico` por modalidade, regra da data de matrícula, marca `ficha_pendente` para perfis legados (checksum `becde7eb…`, protegido por teste)
7. `database/migrations/0007_convites.sql` — tabela `convites` (só o SHA-256 do token; uso único; um convite aberto por e-mail; estados finais imutáveis por trigger) (checksum `588dbb3d…`, protegido por teste)
8. `database/migrations/0008_perfil_aluno.sql` — `aluno_profile.foto_url`, `altura` (m, 0,50–2,50), `peso` (kg, 10–300), `medidas_atualizadas_em` (trigger); tabela `fotos` (WebP/JPEG ≤ 512 KB, 1 por usuário, fora do `aluno_profile` para listagens não carregarem imagem) (checksum `1162c62a…`, protegido por teste)
9. `database/migrations/0009_loja_catalogo.sql` — catálogo do aluno sobre a **mesma** `inventory_product` (+ `descricao`, `imagem_url`; um só cadastro e estoque); `produto_imagens`; `pedidos_loja` (intenção de compra: não baixa estoque nem lança no caixa; 1 pedido em aberto por aluno+produto; só aluno, por trigger)

| Tabela                | Papel                                         | Regras no banco                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `users`               | conta (admin/aluno)                           | email citext único; admin nunca `inadimplente`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `aluno_profile`       | 1:1 com aluno (= _Student_)                   | `numero_matricula` identity; `total_presencas` por trigger; CPF válido e único; CEP/WhatsApp em dígitos; termos ⇔ data+versão; **menor de 18 ⇒ `responsavel_id` obrigatório** (trigger, data de SP). **0006:** contato de emergência obrigatório (`ck_aluno_emergencia_obrigatoria`); Jiu-Jitsu = faixa + grau e `nivel` nulo, demais modalidades = `nivel` (iniciante/intermediario/avancado) com grau 0 e `faixa` espelhando o rótulo (`ck_aluno_nivel_modalidade` + trigger); termo aceito ⇒ autorizações respondidas; `data_matricula` nem futura nem anterior ao nascimento. Perfis anteriores à 0006 ficam `ficha_pendente = true` (isentos até serem completados; a marca some sozinha e nunca volta) |
| `responsaveis`        | _Guardian_; 1 responsável : N alunos (irmãos) | parentesco pai/mae/tutor/outro; telefones E.164 sem "+"; não pode ser apagado com aluno vinculado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `historico_saude`     | _HealthHistory_, 1:1 com aluno                | tipo sanguíneo validado; textos ≤ 2000; **dado sensível (LGPD art. 11)**: só staff e o próprio aluno                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `graduacao_historico` | promoções de faixa/grau                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `financeiro`          | mensalidades                                  | único `(user_id, data_vencimento)`; `pago` ⇔ data+método                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `inventory_product`   | produtos                                      | `estoque_atual >= 0`; nome único entre ativos; soft delete `ativo`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `inventory_movements` | entradas/ajustes de estoque                   | `estoque_novo >= 0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `loja_venda`          | 1 linha por item vendido                      | `valor_total = preço×qtd − desconto`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cash_flow`           | livro-caixa                                   | **append-only** (trigger bloqueia UPDATE/DELETE); categoria×tipo×origem coerentes; `payment_id`/`sale_id` únicos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `attendance`          | check-in/out                                  | 1 sessão aberta por aluno (índice único parcial)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `refresh_tokens`      | sessões                                       | hash SHA-256, `family_id` para revogação em cadeia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `api_rate_limits`     | rate limit por janela de 1 min                | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `idempotency_keys`    | idempotência de vendas (24h)                  | PK `(actor_id, key)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Enums: `user_role`, `user_status` (ativo/inativo/inadimplente), `modalidade` (boxe/jiu_jitsu/muay_thai), `payment_status` (pendente/pago/atrasado), `cash_flow_tipo`, `cash_flow_categoria` (mensalidade/loja/sangria/outros). Domínio `metodo_pagamento` (pix, dinheiro, cartao_credito, cartao_debito, boleto, transferencia).

Funções: `fn_hoje_sp`, `fn_pendencias_bloqueantes`, `fn_sincronizar_status_aluno`, `fn_processar_inadimplencia`, `fn_fechar_presencas_abandonadas`, `fn_balanco_diario`, `fn_assert_role_aluno`, `fn_cash_flow_imutavel`, triggers de `attendance` (incremento + `pg_notify('presenca_evento')`). Views: `vw_presentes_agora`, `vw_contato_aluno` (WhatsApp do aluno, senão o do responsável — canal da Fase 4). Funções novas: `fn_cpf_valido`, `fn_aluno_menor_exige_responsavel` (0005), `fn_nivel_rotulo`, `fn_aluno_ficha_professor` (0006). `vw_contato_aluno.telefone_emergencia` passa a priorizar o contato de emergência do aluno (0006).

Convenções: dinheiro em `NUMERIC`, trafega como **string** no JSON; datas `YYYY-MM-DD`; timestamps ISO com fuso; nada financeiro é apagado fisicamente.

## 6. API — `/api/v1` (69 rotas)

Papel: `public` = sem login · `qualquer` = qualquer autenticado (com `staffOrSelf`/`selfOrAdmin` quando há `:id`) · `STAFF` = `admin` + `professor` · `admin` · `aluno`.

| Módulo        | Método e rota                                                                                                                                                                                                | Papel                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| auth          | `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout`                                                                                                                                              | public (exigem `Origin` exato) |
| auth          | `GET /auth/me` · `PATCH /auth/senha`                                                                                                                                                                         | qualquer                       |
| alunos        | `GET /alunos` · `POST /alunos/:id/graduacoes`                                                                                                                                                                | STAFF                          |
| alunos        | `POST /alunos` (cadastro simples legado) · `PATCH /alunos/:id` · `PATCH /alunos/:id/status`                                                                                                                  | admin                          |
| alunos        | `GET /alunos/:id` (professor recebe **sem** `situacao_financeira`) · `GET /alunos/:id/graduacoes`                                                                                                            | STAFF ou o próprio aluno       |
| cadastro      | `POST /alunos/cadastro` (payload `acesso`→`treino`→`pessoal`→`responsavel?`→`contato_emergencia`→`saude`→`termos`; grava responsável→aluno→saúde em **uma transação**) · `GET /responsaveis?q=`              | STAFF                          |
| cadastro      | `GET /alunos/:id/ficha` (CPF, endereço, saúde, responsável, contato principal)                                                                                                                               | STAFF ou o próprio aluno       |
| equipe        | `GET /professores` · `POST /professores` · `PATCH /professores/:id/status` (inativar revoga sessões)                                                                                                         | admin                          |
| convites | `POST /convites` (`{email, whatsapp?, validade_dias?}` → `url` + `whatsapp_url`; o link só aparece aqui) · `GET /convites?status=` · `DELETE /convites/:id` (revoga) | STAFF |
| perfil | `PATCH /me/perfil` = `PATCH /profile` (`{foto_url?, altura?, peso?}`; `foto_url` só `null` ou a própria foto atual; só números, ponto ou vírgula, 2 casas; `null` apaga; renova `medidas_atualizadas_em`) · `PUT /me/foto` (corpo binário `image/webp`/`image/jpeg` ≤ 512 KB, **decodificado e regravado no servidor com `sharp`**: sem EXIF, ≤ 512 px, ≤ 16 MP) · `DELETE /me/foto` | aluno (só o próprio) |
| loja | `GET /loja/produtos` (catálogo: `id, nome, descricao, preco, imagem_url, estoque, categoria`, só ativos) | qualquer logado |
| loja | `POST /loja/pedido` (`{produto_id, quantidade?}` → `{pedido, whatsapp_url}`; mensagem "Olá, gostaria de adquirir o item …"; 409 `PRODUTO_ESGOTADO`; 503 `LOJA_SEM_WHATSAPP`; 10/min por aluno) | aluno |
| loja | `GET /loja/pedidos` · `PATCH /loja/pedidos/:id` (`atendido`/`cancelado`; 409 `PEDIDO_FINALIZADO`) · `PUT`/`DELETE /produtos/:id/imagem` | admin |
| loja | `GET /loja/imagens/:id` | public |
| perfil | `GET /fotos/:id` (link aleatório que muda a cada upload; cache imutável; `nosniff`) | public |
| convites | `GET /convites/validar/:token` · `POST /convites/:token/cadastro` (ficha completa; e-mail vem do convite; responsável só novo; consome o convite na mesma transação) — limite por IP 30/min e 10/min | public |
| área do aluno | `GET /me/perfil` · `/me/graduacoes` · `/me/mensalidades` · `/me/presencas` · `/me/compras` · `/me/carteirinha`                                                                                               | aluno                          |
| carteirinha   | `POST /carteirinha/validar`                                                                                                                                                                                  | STAFF                          |
| presença      | `POST /presencas/check-in` · `PATCH /presencas/:attendance_id/check-out` · `PATCH /presencas/check-out` · `GET /presencas` · `/presencas/ativas` · `/presencas/estatisticas` · `GET /presencas/stream` (SSE) | STAFF                          |
| financeiro    | `GET/POST /mensalidades` · `POST /mensalidades/lote` · `PATCH/DELETE /mensalidades/:payment_id` · `PATCH /mensalidades/:payment_id/pagar` · `GET /financeiro/inadimplentes` · `/financeiro/resumo`           | admin                          |
| loja          | `GET /produtos` · `GET /produtos/:id`                                                                                                                                                                        | qualquer                       |
| loja          | `POST /produtos` · `PATCH/DELETE /produtos/:id` · `PATCH /produtos/:id/estoque` · `POST/GET /vendas` · `GET /vendas/:sale_id`                                                                                | admin                          |
| caixa         | `GET/POST /caixa/lancamentos` · `POST /caixa/sangrias` · `GET /caixa/balanco` · `/caixa/balanco/periodo`                                                                                                     | admin                          |
| relatórios    | `GET /dashboard`                                                                                                                                                                                             | admin                          |
| infra         | `GET /health` e `GET /api/v1/health`                                                                                                                                                                         | public                         |

Formato de erro único: `{ "error": { "code", "message", "details?" } }`. Códigos novos: `CPF_JA_CADASTRADO` (409), `RESPONSAVEL_NAO_ENCONTRADO` (422); menor sem responsável → 400 `VALIDATION_ERROR` com `details[].path = ["responsavel"]`. Mapeamento de erros do Postgres: `23505` → 409 (código por constraint), `P0002` → 404, `23514/23503/22xxx` → 422, demais → 500 `ERRO_INTERNO` (log só com o `code` do PG, sem valores).

## 7. Segurança e regras de negócio

- **Senha:** Argon2id (19 MiB, t=2). Login com tempo constante (hash dummy para e-mail inexistente).
- **Access token:** JWT HS256 de 15 min (`iss=bonsai`, `aud=bonsai-api`, `typ=access`, `sid`=família). A cada request, papel e status são **relidos do banco**; o claim nunca decide acesso.
- **Refresh token:** opaco, cookie `bonsai_refresh` HttpOnly, SameSite=Strict, `Path=/api/v1/auth`, 30 dias, rotação a cada uso; reuso revoga a família inteira.
- **Rate limit (no Postgres):** 600 req/min por IP em `/api/*`; login 20/min por IP e 5/min por IP+e-mail; 300/min por usuário autenticado; refresh 60/min por IP.
- **Origem:** login/refresh/logout exigem `Origin === CORS_ORIGIN` (sem barra no final). CORS de origem única com credentials. Helmet + CSP (`frame-ancestors 'none'`), `Cache-Control: no-store` na API.
- **Carteirinha:** QR = JWT de 90 s com segredo próprio (`JWT_QR_SECRET`). Emissão e validação recalculam adimplência em tempo real (`fn_sincronizar_status_aluno`). Inadimplente **consegue logar**, mas a carteirinha fica bloqueada.
- **Inadimplência:** `atrasado` = vencido e não pago; **bloqueio** só após `DIAS_CARENCIA` (padrão 5). O status é atualizado pelo job diário, pelo pagamento e na emissão/validação da carteirinha.
- **Vendas:** `UPDATE ... WHERE estoque >= qtd` atômico, locks em ordem de `product_id`, `Idempotency-Key` obrigatório, rollback do carrinho inteiro.
- **Nível por modalidade:** `validarNivelPorModalidade` (`src/lib/cadastro.ts`) é a regra única usada em `POST /alunos/cadastro`, `POST /alunos` (legado, que agora também exige `contato_emergencia`) e na troca de modalidade do `PATCH /alunos/:id`. Promoção (`POST /alunos/:id/graduacoes`): Jiu-Jitsu usa `faixa_nova` + `graduacao_nova`; demais usam `nivel_novo`. Nível aceita "Intermediário" ou "intermediario" e grava o código.
- **Cadastro (Fase 1):** schema Zod único em `src/lib/cadastro.ts` normaliza CPF/CEP/telefones (DDD+número ganha `55`), valida CPF por dígito verificador e exige responsável se idade < 18 na data de São Paulo (aniversário de 18 anos = adulto). O banco repete CPF, menoridade e termos. Responsável pode ser novo ou `{ id }` existente (irmãos). Falha em qualquer etapa desfaz tudo, inclusive o responsável recém-criado.
- **Professor:** papel `professor` — alunos, ficha, graduações, presença, check-in e validação de carteirinha; **403** em financeiro, caixa, loja, dashboard, edição/status de aluno e gestão de equipe. Front: telas Alunos, Presença e Minha senha.
- **Job diário:** fecha presenças abertas há mais de 4h, limpa tokens/idempotência/rate-limit expirados e, se `BILLING_ENABLED`, gera mensalidades e processa inadimplência.

## 8. Front-end (`src/`)

| Arquivo                     | Conteúdo                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------ |
| `App.tsx`                   | `Login`, roteamento por estado (`View`), sidebar/menu mobile, splash, troca de senha |
| `components/Academy.tsx`    | `Dashboard`, `Students`, `Presence`                                                  |
| `components/Operations.tsx` | `Finance`, `Store`, `Cash`                                                           |
| `components/Member.tsx`     | área do aluno ("Minha jornada"): carteirinha com QR e foto, altura/peso, mensalidades |
| `components/Loja.tsx`       | catálogo do aluno (grade 2/3/4 colunas, busca, modal de detalhe, "Solicitar Compra" → WhatsApp); gestor ganhou foto/descrição do produto e "Pedidos dos alunos" em `Operations.tsx` |
| `components/Perfil.tsx`     | `Avatar`, formatação de altura/peso, botão de lápis (leve, sem Zod)                  |
| `components/EditarPerfil.tsx` | modal (lazy, `<dialog>`; folha inferior no celular): foto da câmera/galeria recortada para 512 px e regravada em WebP no aparelho (sem EXIF/GPS), altura e peso validados com `lib/perfil.ts` |
| `components/Cadastro.tsx`   | página pública `/cadastro?token=` (lazy): trava sem token, ficha em etapas Acesso → Treino → Dados → Responsável (só < 18) → Emergência → Saúde → Termo, validada com os schemas de `lib/cadastro.ts` |
| `components/Logo.tsx`       | `Logo` responsiva, `Wordmark`, `useScrolled`                                         |
| `components/ui.tsx`         | `Card`, `Table`, `Pager`, `Form`, `Notice`, `Status`, `Loading`, `useResource`       |
| `lib/api.ts`                | cliente HTTP, access token em memória, refresh com Web Locks entre abas, SSE         |
| `lib/demo-accounts.ts`      | credenciais demo (eliminadas do bundle de produção)                                  |
| `types/contract.ts`         | tipos compartilhados front/API (espelho do contrato v1.0)                            |
| `index.css`                 | `@theme` (tokens) + CSS legado das telas (só `var(--color-*)`)                       |

- **Rota pública:** `/cadastro` é decidida em `App()` antes da sessão; sem token ou com convite inválido/expirado/usado mostra "Acesso restrito"/"Convite indisponível". Equipe gera o link em Alunos → Convidar aluno (copiar link ou abrir no WhatsApp).
- **Admin:** Visão geral, Alunos, Presença, Mensalidades, Loja e estoque, Fluxo de caixa, Minha senha. **Professor:** Alunos (sem cadastro simples/edição/status), Presença, Minha senha. **Aluno:** Minha carteirinha, Minha senha. Mapa em `VIEWS` (`App.tsx`).
- **Logo (`public/assets/`):** `logo-full.png` (1024px, desktop ≥1024), `logo-mobile.png` (512px, ≥360px), `logo-icon.png` (256px, <360px ou header recolhido); o wordmark é HTML. **Esses PNGs não podem ir para o Git LFS** (`public/.gitattributes`), porque o build do Railway não baixa LFS.
- **Layout mobile:** `min-h-screen` com upgrade para `100svh`, `justify-center-safe`, variante `short:` (altura ≤720px) e título dimensionado em `cqi`.
- **Demo:** botões Gestor/Professor/Aluno só com `vite dev` + `VITE_DEMO_LOGIN=true`; `pnpm demo:seed` cria `gestor@` (admin), `professor@` (professor), `aluno@` (adulto, ficha completa) e `menor@` (menor com responsável) em `bonsai.demo`.

## 9. Design system (Tailwind 4 `@theme`)

| Token                      | Valor                 | Uso                                                                |
| -------------------------- | --------------------- | ------------------------------------------------------------------ |
| `primary`                  | `#FF0000`             | ícones, foco, bordas de destaque, texto sobre `background` (5,3:1) |
| `secondary` / `background` | `#000000`             | fundo da página                                                    |
| `accent`                   | `#FFFFFF`             | fundo do QR, realces                                               |
| `surface`                  | `#1A1A1A`             | cards, sidebar, modais                                             |
| `text-main` / `text-muted` | `#FFFFFF` / `#A0A0A0` | texto (17,4:1 / 6,6:1 sobre surface)                               |
| `primary-strong`           | `#D10000`             | fundo de botões com texto branco (5,7:1)                           |
| `primary-soft`             | `#FF3B3B`             | texto vermelho pequeno sobre surface (4,9:1)                       |
| `surface-raised`           | `#262626`             | inputs, hover, cabeçalho de tabela                                 |
| `border` / `border-strong` | `#333333` / `#6B6B6B` | divisórias / contorno de controles (3,3:1)                         |
| `success`                  | `#3DDC84`             | status "Ativo" e confirmações                                      |

Fonte display: Barlow Condensed (títulos itálicos extra-bold); corpo: Archivo. **Regra:** nenhuma cor fixa fora do `@theme`; `pnpm lint:colors` reprova hex, rgb/hsl, paleta padrão do Tailwind e tokens legados (roda no CI).

## 10. Configuração (variáveis de ambiente)

| Variável                                                                     | Obrigatória | Observação                                                          |
| ---------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `DATABASE_URL`                                                               | sim         | no Railway: `${{Postgres.DATABASE_URL}}`                            |
| `JWT_ACCESS_SECRET`, `JWT_QR_SECRET`                                         | sim         | ≥32 chars, diferentes; em produção não podem começar com `replace-` |
| `CORS_ORIGIN`                                                                | sim         | URL pública exata; `https://` obrigatório em produção               |
| `NODE_ENV`                                                                   | —           | `production` no Dockerfile                                          |
| `SERVE_WEB`                                                                  | —           | `true` no Dockerfile (API serve o `dist/`)                          |
| `PORT` (3001), `PG_POOL_MAX` (10), `COOKIE_SAME_SITE` (strict)               | —           | —                                                                   |
| `DIAS_CARENCIA` (5)                                                          | —           | carência antes do bloqueio                                          |
| `BILLING_ENABLED` (false), `BILLING_AMOUNT` (150.00), `BILLING_DUE_DAY` (10) | —           | geração automática de mensalidades                                  |
| `WHATSAPP_LOJA` (sem padrão) | — | número da loja (DDI+DDD+número) para o "Solicitar Compra"; sem ele o pedido responde 503 |
| `VITE_API_URL`                                                               | —           | só para front hospedado separadamente                               |
| `VITE_DEMO_LOGIN`                                                            | —           | só desenvolvimento                                                  |

## 11. Comandos

| Comando                                   | Faz                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `pnpm dev` / `pnpm dev:api`               | Vite (8443) / API com watch (3001, lê `.env`)                                        |
| `pnpm build`                              | typecheck (web+API) → `vite build` → `build:api`                                     |
| `pnpm test`                               | integração (exige `TEST_DATABASE_URL` apontando para um banco chamado `bonsai_test`) |
| `pnpm lint:colors` · `pnpm audit:queries` | lint da paleta · auditoria de queries                                                |
| `pnpm db:migrate`                         | `node apps/api/dist/migrate.js`                                                      |
| `pnpm admin:create`                       | `node apps/api/dist/bootstrap-admin.js` (JSON `{email,nome,senha≥12}` via stdin)     |
| `pnpm demo:seed`                          | contas demo (dev; usa `.env`)                                                        |
| `pnpm job:daily`                          | job diário manual                                                                    |

## 12. Qualidade e CI

- **`.github/workflows/ci.yml`** (push e PR): Postgres 18 → `pnpm install --frozen-lockfile` → `lint:colors` → `build` → `test` → `pnpm audit --prod --audit-level=high`.
- **Último resultado local (19/11):** typecheck ok, builds ok, **56/56 testes** (perfil: medidas estritas, foto com assinatura/tipo/tamanho, troca e remoção; checksums 0001–0007, upgrade 0005→0006, convites: hash do token, expiração, revogação, uso único concorrente, rollback), credenciais demo ausentes do bundle; upgrade real validado (0005→0006 e 0006→0007 com `migrate.ts`); fluxo de convite percorrido no Chrome headless (mobile e desktop).
- **Cobertura dos testes:** JWT (expirado/forjado/contexto/algoritmo), RBAC/IDOR, origem e headers, rotação/replay/corrida de refresh, revogação, carência e bloqueio da carteirinha, check-in concorrente, pagamento duplo, caixa imutável, mensalidades idempotentes (inclusive 29/02), venda concorrente do último item, idempotência de venda, rollback de carrinho, SSE via LISTEN, path traversal no static, relatórios.
- **Codex Security:** workflows removidos temporariamente (`15e9f86`). O relatório (`docs/CODEX_SECURITY_REPORT.md`) está **parcial**: Deep Scan interrompido por cota. Para reativar: configurar o Environment `codex-security` protegido **antes** de reverter `15e9f86`.

## 13. Estado atual e pendências

| #   | Item                                             | Situação                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Login em produção retornava 500 em todo `/api/*` | Causa reproduzida: banco do Railway **sem migrações** (`42P01`, tabela `api_rate_limits` inexistente). Correção: rodar `node apps/api/dist/migrate.js` no serviço, depois `bootstrap-admin.js`. **Execução no Railway não confirmada.**                                                                     |
| 2   | Pre-deploy não aplicou migrações                 | Investigar se o serviço usa `railway.json` e se a `DATABASE_URL` aponta para o Postgres correto                                                                                                                                                                                                             |
| 3   | `/health` faz só `SELECT 1`                      | Não detecta banco sem migrações; melhoria proposta, não implementada                                                                                                                                                                                                                                        |
| 4   | Codex Security                                   | Workflows desativados; Deep Scan completo pendente                                                                                                                                                                                                                                                          |
| 5   | Documentos defasados                             | `docs/CODEX_SECURITY.md` ainda descreve os workflows como ativos; `docs/ARQUITETURA.md` é o desenho inicial (o código é a referência)                                                                                                                                                                       |
| 6   | `.metric.lime`, `.qr`, `.belt-badge`             | CSS sem uso nos componentes (código morto)                                                                                                                                                                                                                                                                  |
| 7   | Modelo                                           | Um aluno = uma modalidade (`aluno_profile` 1:1); multi-modalidade exigiria PK `(user_id, modalidade)`                                                                                                                                                                                                       |
| 8   | Cadastro — fases seguintes                       | **Fase 2:** formulário multi-etapas (Dados → Saúde → Responsável → Termos) usando `src/lib/cadastro.ts`; edição da ficha (`PATCH`) ainda não existe. **Fase 3:** carteirinha já existe (QR 90 s); falta exibir dados de menor/responsável. **Fase 4:** lembretes por link `wa.me` sobre `vw_contato_aluno`. |
| 9   | Alunos legados                                   | Cadastrados antes da 0005 não têm CPF/nascimento/saúde (colunas anuláveis); completar pela edição da Fase 2                                                                                                                                                                                                 |
| 10  | Decisão registrada                               | Especificação pedia Prisma, tabela `Student` separada e nomes em inglês; adotado SQL versionado, `aluno_profile` estendido e nomes em português (consistência com o projeto). `prisma db pull` continua possível.                                                                                           |

## 14. Histórico (`main`)

| Commit    | Conteúdo                                                               |
| --------- | ---------------------------------------------------------------------- |
| `49cb602` | base: ERP completo (API, banco, front, testes, docs)                   |
| `149aa60` | identidade BONSAI no login, logo responsiva, contas demo               |
| `72899a7` | workflows Codex Security + testes JWT/RBAC/origem                      |
| `15e9f86` | remoção temporária dos workflows Codex                                 |
| `432717a` | logos fora do LFS, layout mobile (`svh`), alerta de erro               |
| `d8dcd5e` | paleta semântica no `@theme`, tema escuro em todo o app, `lint:colors` |
