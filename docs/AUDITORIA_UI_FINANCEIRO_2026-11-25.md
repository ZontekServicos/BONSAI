# Auditoria de UI e sincronização financeira — 25/11/2026

## Resumo executivo

As alterações auditadas estão aptas para publicação. A área do aluno e o painel administrativo usam a mesma consulta para a competência atual; a rota do aluno deriva a identidade exclusivamente da sessão autenticada; a geração de cobrança é transacional e a restrição única do banco impede duplicidade. Não foram encontrados achados de segurança críticos, altos ou médios no escopo revisado.

A suíte completa passou com **76/76 testes**, além de build com typecheck, `lint:colors`, auditoria de queries, formatação dos arquivos alterados e auditoria de dependências de produção sem vulnerabilidades conhecidas.

## Escopo

- Flag e geração de cobrança no painel de mensalidades.
- Remoção do cabeçalho "Minha jornada" e integração da carteirinha ao dashboard do aluno.
- Espelhamento do status financeiro entre gestor e aluno.
- Isolamento por identidade autenticada, RBAC e exposição do valor padrão.
- Atomicidade e proteção contra cobranças duplicadas.
- Responsividade em 320 px, 390 px e desktop.

## Resultado funcional

### AUD-01 — Fonte única para a competência atual

**Resultado:** aprovado.

`situacaoDoMes` reutiliza o mesmo CTE e as mesmas colunas do painel do gestor. A rota do aluno chama essa função sem aceitar `user_id` do cliente:

- `apps/api/src/modules/billing.ts:78-87`
- `apps/api/src/modules/alunos.ts:343-344`

Os testes cobrem ausência de cobrança, cobrança criada, baixa confirmada e divergência artificial entre `financeiro.status` e a entrada real no caixa:

- `apps/api/test/integration.test.ts:2479`
- `apps/api/test/integration.test.ts:2494`
- `apps/api/test/integration.test.ts:2516`

### AUD-02 — Isolamento e autorização

**Resultado:** aprovado.

A rota `GET /me/mensalidades/atual` exige o papel `aluno` e usa apenas `r.account.id`. O histórico também filtra por esse identificador parametrizado. O painel aceita gestor/professor, mas `valor_padrao` só é serializado para o gestor:

- `apps/api/src/modules/alunos.ts:309-344`
- `apps/api/src/modules/billing.ts:409-460`
- `apps/api/test/integration.test.ts:2534-2544`

Não existe parâmetro de rota, query ou body que permita ao aluno escolher outro usuário.

### AUD-03 — Atomicidade e duplicidade

**Resultado:** aprovado.

A criação individual executa o lock do aluno, o `INSERT` e a sincronização de status dentro da mesma transação. A restrição `UNIQUE (user_id, data_vencimento)` impede duas cobranças iguais mesmo sob concorrência, e o tratamento global converte a violação em HTTP 409 `MENSALIDADE_DUPLICADA`:

- `apps/api/src/modules/billing.ts:251-277`
- `database/schema.sql:161-178`
- `apps/api/src/app.ts:93-106`

No cliente, `enviando` bloqueia submissões repetidas enquanto a primeira requisição está em andamento. A restrição do banco permanece como garantia autoritativa.

### AUD-04 — UI e responsividade

**Resultado:** aprovado.

- A flag é renderizada para todo item pendente, sem depender de `payment_id` (`src/components/PainelMensalidades.tsx:464-475`).
- O checkbox continua visível para o gestor e fica desabilitado até a cobrança existir.
- O botão "Gerar cobrança" só aparece para gestor, pendência e ausência de cobrança.
- O cabeçalho "Minha jornada" foi removido do dashboard; o nome acessível da página permanece via `h1.sr-only` (`src/App.tsx:432-499`).
- O mês atual aparece antes do histórico na área do aluno (`src/components/Member.tsx:45-50`, `src/components/Member.tsx:220-253`).

As capturas revisadas em 320 px, 390 px e desktop não apresentam rolagem horizontal. Em 320 px, a assinatura visual reduz para o emblema para preservar espaço; em 390 px, o logo completo é exibido.

## Auditoria de segurança

### Crítico

Nenhum achado.

### Alto

Nenhum achado.

### Médio

Nenhum achado.

### Baixo / observações

Nenhuma vulnerabilidade nova identificada. A busca estática não encontrou inserção de HTML não confiável, execução dinâmica de código, armazenamento de token em Web Storage ou segredo em variáveis `VITE_*` no escopo entregue. O token de acesso permanece apenas em memória; o refresh token usa cookie HttpOnly. Helmet fornece CSP e cabeçalhos de proteção no servidor.

## Evidências de validação

- `pnpm build`: aprovado (typecheck, Vite e build da API).
- `pnpm lint:colors`: aprovado, 20 arquivos verificados.
- `pnpm test`: aprovado, 76/76 testes.
- `pnpm audit:queries`: aprovado; índices esperados utilizados.
- `pnpm audit --prod --audit-level=high`: nenhuma vulnerabilidade conhecida.
- `oxfmt --check` nos arquivos alterados: aprovado após normalização de `docs/MAPA_TECNICO.md`.
- `git diff --check`: aprovado.

## Conclusão

O espelhamento Admin/Aluno, o isolamento por sessão, a proteção contra duplicidade e a regressão visual solicitada foram validados. Não há bloqueio técnico ou de segurança para merge na `main` e deploy no Railway.
