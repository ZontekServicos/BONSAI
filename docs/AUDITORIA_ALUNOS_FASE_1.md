# Auditoria técnica — Cadastro de Alunos (Fase 1)

**Data:** 19/11/2026  
**Escopo:** `POST /api/v1/alunos/cadastro`, persistência PostgreSQL e autorização por papel  
**Resultado geral:** **PASSOU — 4/4 controles validados**

## Resumo executivo

Os quatro controles solicitados foram confirmados em uma base PostgreSQL descartável chamada
`bonsai_test`, usando schemas aleatórios e isolados. A suíte completa passou com **28/28 testes**.
Além disso, foi executada uma injeção de falha específica no `INSERT` de `historico_saude` por meio
de um trigger temporário. O endpoint respondeu com erro e nenhuma conta ou perfil do aluno permaneceu
no banco, confirmando o rollback.

Nenhuma vulnerabilidade ou falha funcional foi encontrada nos itens deste checklist.

## Ambiente e método

- Backend: TypeScript, Fastify 5 e PostgreSQL 18.
- Runner: Vitest 5, por `app.inject`, sem depender de rede externa.
- Banco: `bonsai_test`, porta local 55439, com schema aleatório removido ao final.
- Comando da suíte completa: `pnpm test`.
- Resultado: `1 passed`, `28 passed`, duração de 13,04 s.
- Comando focal: `pnpm exec vitest run --reporter=verbose -t 'requires a guardian|rolls back the new guardian|gives professors'`.
- Resultado focal: `1 passed`, `3 passed`, `25 skipped`, duração de 4,70 s.

## Resultado por controle

### QA-01 — Integridade transacional: PASSOU

**Evidência estática**

- A implementação abre `db.transaction` antes de criar responsável, usuário, perfil e histórico de
  saúde: `apps/api/src/modules/cadastro.ts:66-142`.
- Todas as gravações usam o mesmo cliente transacional `tx`: responsável em `:78-91`, usuário em
  `:94-98`, perfil em `:99-125` e saúde em `:127-140`.
- O adaptador executa `BEGIN`, `COMMIT` e, em qualquer exceção, `ROLLBACK`:
  `apps/api/src/db.ts:29-41`.

**Teste de falha injetada no HealthHistory**

Foi criado, em schema isolado, um trigger temporário `BEFORE INSERT ON historico_saude` que sempre
lançava uma exceção. Em seguida, o endpoint real foi chamado com token de professor e payload válido.

```json
{
  "injected_failure": "BEFORE INSERT ON historico_saude",
  "http_status": 500,
  "error_code": "ERRO_INTERNO",
  "student_user_rows_after_failure": 0,
  "student_profile_rows_after_failure": 0,
  "rollback_confirmed": true
}
```

O trigger e o schema foram removidos ao final. Como evidência complementar, o teste de integração
`rolls back the new guardian and user when a later step fails`, em
`apps/api/test/integration.test.ts:814-832`, também passou e confirma que um responsável recém-criado
não permanece quando um passo posterior falha.

**Conclusão:** aluno, responsável e saúde participam da mesma transação; uma falha na criação de
`HealthHistory` desfaz a conta e o perfil do aluno.

### QA-02 — Menor sem responsável: PASSOU

**Entrada:** aluno com 12 anos, `whatsapp: null` e sem `responsavel`.  
**Esperado:** HTTP 400.  
**Obtido:** HTTP 400, com `VALIDATION_ERROR` e detalhe apontando para `responsavel`.

O cenário está em `apps/api/test/integration.test.ts:773-777` e passou no teste focal. A regra é
aplicada pelo schema Zod em `src/lib/cadastro.ts:140-155` e possui uma segunda defesa no banco pelo
trigger de `database/migrations/0005_cadastro_aluno.sql:97-117`.

Também passou o teste de fronteira de idade em `apps/api/test/integration.test.ts:806-812`: no dia do
18º aniversário o responsável deixa de ser obrigatório; no dia anterior ainda é exigido.

### QA-03 — Unicidade de CPF: PASSOU

**Entrada:** segundo cadastro usando o CPF de um aluno já criado.  
**Esperado:** rejeição do segundo cadastro.  
**Obtido:** HTTP 409, código `CPF_JA_CADASTRADO`.

O cenário e suas asserções estão em `apps/api/test/integration.test.ts:814-825` e passaram. A garantia
de concorrência está no índice único parcial `uq_aluno_cpf`, em
`database/migrations/0005_cadastro_aluno.sql:94`, e o erro PostgreSQL `23505` é convertido para o
código de domínio em `apps/api/src/app.ts:89-101`.

**Conclusão:** dois alunos não podem persistir com o mesmo CPF; a proteção está no banco, não apenas
na validação da aplicação.

### QA-04 — Controle de acesso: PASSOU

**Entrada:** `POST /api/v1/alunos/cadastro` com token válido de usuário comum (`role: aluno`).  
**Esperado:** HTTP 403 Forbidden.  
**Obtido:** HTTP 403, código de domínio `SEM_PERMISSAO`.

O teste está em `apps/api/test/integration.test.ts:905-907` e passou. A rota aceita somente `STAFF`
em `apps/api/src/modules/cadastro.ts:56-62`; `STAFF` contém apenas `admin` e `professor`, conforme
`apps/api/src/http.ts:55-56`. A checagem ocorre no `preHandler`, antes do parse e do handler, em
`apps/api/src/http.ts:79-84`.

**Conclusão:** um aluno autenticado não consegue iniciar o fluxo de cadastro.

## Matriz final

| ID | Controle | Resultado | Evidência principal |
|---|---|---|---|
| QA-01 | Transação e rollback na falha de saúde | **PASSOU** | Falha injetada; HTTP 500; 0 usuários e 0 perfis residuais |
| QA-02 | Menor sem responsável | **PASSOU** | HTTP 400; detalhe em `responsavel` |
| QA-03 | CPF único | **PASSOU** | HTTP 409; `CPF_JA_CADASTRADO` |
| QA-04 | Usuário comum sem permissão | **PASSOU** | HTTP 403; `SEM_PERMISSAO` |

## Observação de cobertura

A injeção específica de falha em `historico_saude` foi executada como teste de auditoria temporário,
sem alterar o código da aplicação. Recomenda-se transformar esse cenário em um teste de regressão
permanente para impedir que uma futura refatoração mova a gravação de saúde para fora da transação.
