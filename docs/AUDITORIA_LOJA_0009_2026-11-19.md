# Auditoria técnica — Loja / migração 0009

**Data:** 19/11/2026  
**Auditor:** Codex  
**Base:** `main` a partir de `ef093ad`; entrega 0009 auditada antes do commit  
**Veredito:** **APROVADO PARA COMMIT, PUSH E DEPLOY**.

## Resumo executivo

O cadastro de pedidos está protegido por autenticação e papel `aluno`, o limite de dez pedidos por
minuto foi comprovado, o trigger do banco rejeita usuários que não sejam alunos e a migração 0009
faz upgrade e rollback de forma atômica. A grade é mobile-first com duas colunas, o ciclo do modal
está coerente e `WHATSAPP_LOJA` foi incluída e validada.

Os três achados da primeira rodada foram corrigidos e revalidados. O CORS anuncia `PUT`; as URLs de
produto e perfil aceitam somente caminhos internos da API; e toda imagem precisa ser decodificada e
regravada pelo `sharp`, com limite de pixels, dimensões máximas e remoção de metadados. Arquivos
corrompidos, truncados, com MIME divergente ou apenas magic bytes falsos são recusados sem substituir
a imagem válida anterior.

## Matriz de resultados

| Controle | Resultado | Evidência |
|---|---|---|
| `POST /loja/pedido` exige login | **PASSOU** | Requisição anônima: HTTP 401 |
| Apenas aluno cria pedido | **PASSOU** | Admin na API: HTTP 403; SQL direto: PostgreSQL `23514` |
| Rate limit 10/min por aluno | **PASSOU** | Respostas 1–10: `201, 200 × 9`; 11ª: HTTP 429 |
| Payload estrito | **PASSOU** | UUID e quantidade 1–10 validados por Zod; campos extras recusados |
| Sem baixa automática de estoque/caixa | **PASSOU** | Suíte confirma estoque e caixa inalterados |
| WhatsApp centralizado | **PASSOU** | URL montada exclusivamente com `config.WHATSAPP_LOJA` |
| Migração 0008 → 0009 | **PASSOU** | Migrador concluiu com status 0; checksum 0009 `bb83a8bf49e7835befe69399a5b27752798f1fd91355dbd225099893db0f617f` |
| Compatibilidade com produtos existentes | **PASSOU** | `descricao` e `imagem_url` ficaram `NULL` |
| Atomicidade da 0009 | **PASSOU** | Falha forçada após o `ALTER TABLE` removeu colunas, tabelas e registro da migração |
| Migrações 0005–0008 intactas | **PASSOU** | Checksums coincidem com `HEAD` |
| Grid móvel com duas colunas | **PASSOU** | `grid-cols-2`, expandindo para 3/4 em `md`/`xl` |
| Abrir/fechar modal | **PASSOU (estrutural)** | `showModal()` ao montar; fechamento por botão, backdrop e evento `close`; desmontagem libera o top layer |
| `.env.example` | **PASSOU** | Contém exemplo documentado de `WHATSAPP_LOJA` |
| Suíte automatizada | **PASSOU** | 56/56 |
| Build e typecheck | **PASSOU** | Web e API compiladas |
| Lint de cores | **PASSOU** | 19 arquivos verificados |
| Auditoria de dependências | **PASSOU** | Nenhuma vulnerabilidade conhecida |
| Preflight do upload | **PASSOU** | HTTP 204 e `Access-Control-Allow-Methods` contém `PUT` |
| URL de imagem no banco | **PASSOU** | Produto e perfil rejeitam HTTPS externo com PostgreSQL `23514` |
| Validade real do arquivo de imagem | **PASSOU** | `sharp` decodifica/regrava; corrompidos e magic bytes falsos retornam HTTP 400 |
| Privacidade de metadados | **PASSOU** | Marcador EXIF não sobrevive à imagem persistida/servida |

## Revalidação dos achados

### LOJA-01 — CORS para upload `PUT`: RESOLVIDO

- **Local:** `apps/api/src/app.ts:47-51`.
- **Correção validada:** `PUT` está na allowlist do CORS.
- **Evidência:** preflight real e teste permanente retornam HTTP 204 com `PUT` em
  `Access-Control-Allow-Methods`.

### LOJA-02 — URLs externas em imagens: RESOLVIDO

- **Local:** `database/migrations/0009_loja_catalogo.sql:16-23` e `:64-73`.
- **Correção validada:** `imagem_url` aceita somente `/api/v1/loja/imagens/<uuid>` e `foto_url`
  somente `/api/v1/fotos/<uuid>`. A 0008 publicada permanece intacta; sua constraint é endurecida
  pela nova 0009.
- **Evidência:** SQL direto com `https://tracker.test/x` falhou com `23514` nas duas tabelas.

### LOJA-03 — Decodificação e normalização: RESOLVIDO

- **Local:** `apps/api/src/image.ts:1-45`, usado pelo perfil e pela Loja.
- **Correção validada:** `sharp` decodifica a imagem, confirma formato/MIME, limita a 16 megapixels,
  redimensiona para caber em 512×512 e regrava JPEG/WebP sem metadados.
- **Evidência:** magic bytes falsos, arquivo truncado, MIME divergente e bytes aleatórios retornaram
  HTTP 400; a imagem anterior permaneceu vigente. Um marcador EXIF inserido no teste desapareceu
  do conteúdo servido.

## Conclusão

Todos os controles obrigatórios e os três achados passaram na reauditoria. O módulo está liberado
para commit e push. Após o deploy, configurar `WHATSAPP_LOJA` no Railway com DDI, DDD e número,
somente dígitos.
