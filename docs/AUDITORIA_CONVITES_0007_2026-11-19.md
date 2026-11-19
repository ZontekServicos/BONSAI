# Auditoria técnica de segurança — Convites de cadastro (0007)

**Data:** 19/11/2026  
**Escopo:** migração, tokens, concorrência, expiração, regras de cadastro e rate limiting  
**Veredito:** **APROVADO PARA COMMIT E PUSH**

## Resumo executivo

Todos os controles solicitados passaram. A `0007` foi aplicada com sucesso sobre um banco parado na
`0006`; uma falha deliberada no meio da migração reverteu tabela, índices e registro de migração. As
migrações publicadas `0005` e `0006` mantêm seus checksums.

O banco armazena somente SHA-256 do token aleatório de 256 bits. Duas requisições concorrentes com o
mesmo link criaram exatamente uma conta. Tokens expirados ou consumidos não podem cadastrar, o e-mail
do corpo não pode substituir o e-mail do convite e os limites por IP dispararam nos pontos definidos.

Nenhum achado bloqueador foi identificado no escopo desta auditoria.

## Matriz de resultados

| ID | Controle | Resultado | Evidência |
|---|---|---|---|
| INV-01 | Atomicidade da `0007` | **PASSOU** | Falha forçada: processo 1; tabela `convites` ausente; zero registro em `schema_migrations` |
| INV-02 | Checksum da `0005` | **PASSOU** | `0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3` |
| INV-03 | Checksum da `0006` | **PASSOU** | `becde7ebd4cef4f92a70107e93bda1436b5221293fb58d56c0e73fa8df54a24c` |
| INV-04 | Upgrade real `0006 → 0007` | **PASSOU** | Exit 0; `Applied migrations/0007_convites.sql`; checksum registrado |
| INV-05 | Token armazenado como SHA-256 | **PASSOU** | Token de 43 caracteres; coluna contém exatamente seu SHA-256 hexadecimal de 64 caracteres |
| INV-06 | Corrida com o mesmo token | **PASSOU** | Respostas 201 e 410; exatamente uma conta criada |
| INV-07 | Expiração | **PASSOU** | Validação e cadastro retornaram 410 `CONVITE_EXPIRADO` |
| INV-08 | Menor sem responsável | **PASSOU** | HTTP 400 `VALIDATION_ERROR` |
| INV-09 | Vínculo de e-mail | **PASSOU** | Tentativa de incluir e-mail B no corpo retornou 400; conta criada usa o e-mail A do convite |
| INV-10 | Uso único sequencial | **PASSOU** | Nova tentativa retornou 410 `CONVITE_UTILIZADO` |
| INV-11 | URL baseada em `CORS_ORIGIN` | **PASSOU** | Origem configurada e origem do link coincidiram exatamente |
| INV-12 | Rate limit da validação | **PASSOU** | Primeiras 30: 200; 31ª: 429 |
| INV-13 | Rate limit do cadastro | **PASSOU** | Primeiras 10 com token inexistente: 404; 11ª: 429 |

## 1. Integridade de banco

### Checksums publicados

```json
{
  "migration_0005": "0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3",
  "migration_0006": "becde7ebd4cef4f92a70107e93bda1436b5221293fb58d56c0e73fa8df54a24c"
}
```

Não há diff em `database/migrations/0005_cadastro_aluno.sql` nem em
`database/migrations/0006_ajustes_ficha_professor.sql`. O teste permanente que fixa esses hashes está
em `apps/api/test/integration.test.ts:1181-1199`.

### Atomicidade da 0007

Foi criado um conflito deliberado de tipo de rotina antes da aplicação da `0007`, fazendo a migração
falhar depois dos comandos de criação da tabela e dos índices. Resultado após o rollback:

```json
{
  "forced_failure_exit_code": 1,
  "convites_table_after_failure": null,
  "migration_row_after_failure": 0
}
```

O migrador envolve cada arquivo em `BEGIN/COMMIT` e executa `ROLLBACK` na exceção em
`apps/api/src/migrate.ts:34-44`.

### Upgrade 0006 → 0007

O cenário isolado executou todas as migrações até a `0006`, gravou seus checksums em
`schema_migrations` e chamou o migrador atual. Resultado:

```json
{
  "exit_code": 0,
  "stdout": "Applied migrations/0007_convites.sql",
  "checksum_recorded": "588dbb3d50dfd4a51f8da5f74ba66e92601446b39bfd01bed7c99d1d632a06f7"
}
```

A `0007` entra depois da `0006` em `apps/api/src/migrate.ts:16-24`.

## 2. Segurança do token

O token é gerado com `randomBytes(32).toString("base64url")` e somente
`SHA-256(token)` entra no SQL, conforme `apps/api/src/modules/convites.ts:22-24` e `:83-97`.

Exemplo observado, sem registrar o token bruto no relatório:

```json
{
  "raw_token_length": 43,
  "stored_value": "0f5d1bbae476c4a7ee9569aa92c07e563fc56280f8baa4da9490ab25f163192e",
  "expected_sha256": "0f5d1bbae476c4a7ee9569aa92c07e563fc56280f8baa4da9490ab25f163192e",
  "raw_token_absent_from_stored_value": true
}
```

A busca também transforma o token recebido em SHA-256 antes da consulta em
`apps/api/src/modules/convites.ts:48-62`.

## 3. Concorrência, expiração e regras de negócio

### Race condition e uso único

Duas chamadas simultâneas de cadastro com o mesmo token retornaram `[201, 410]`. A consulta ao banco
encontrou exatamente uma conta para o e-mail convidado. Uma terceira tentativa sequencial retornou
410 `CONVITE_UTILIZADO`.

O convite é relido com `FOR UPDATE` e consumido na mesma transação que chama `inserirAluno`, em
`apps/api/src/modules/convites.ts:193-215`. O trigger da `0007` impede reabrir estados finais em
`database/migrations/0007_convites.sql:51-71`.

### Expiração

Após simular passagem do tempo no banco:

- `GET /convites/validar/:token`: 410 `CONVITE_EXPIRADO`;
- `POST /convites/:token/cadastro`: 410 `CONVITE_EXPIRADO`.

### Menor e vínculo de e-mail

- Menor de 12 anos sem responsável: 400 `VALIDATION_ERROR`.
- Inclusão de `acesso.email=email_B` no payload: 400, pois o schema público é estrito e omite e-mail.
- O cadastro concorrente bem-sucedido criou somente `email_A`, vindo do convite.

As regras estão em `src/lib/cadastro.ts:253-287` e `:294-316`; a API injeta o e-mail do registro
travado em `apps/api/src/modules/convites.ts:200-213`.

## 4. Infraestrutura e rate limiting

Com `CORS_ORIGIN=https://bonsai-audit.example`, o link foi gerado como
`https://bonsai-audit.example/cadastro?token=...`, confirmando o uso da variável em
`apps/api/src/modules/convites.ts:65-67` e `:104-114`.

Os testes por endereço IP isolado confirmaram:

```json
{
  "validation_first_30_unique_statuses": [200],
  "validation_31st_status": 429,
  "registration_first_10_unique_statuses": [404],
  "registration_11th_status": 429
}
```

Os limites estão aplicados em `apps/api/src/modules/convites.ts:172-180` e `:189-198`; o contador
atômico no PostgreSQL está em `apps/api/src/auth.ts:14-23`.

## 5. Regressão e qualidade

- `pnpm test`: **39/39 testes aprovados**.
- `pnpm build`: typecheck, Vite e build da API aprovados.
- `pnpm lint:colors`: **13 arquivos aprovados**.
- Testes permanentes dos convites: `apps/api/test/integration.test.ts:1277-1439`.

## Decisão

**APROVADO PARA COMMIT E PUSH.** Não foram encontradas falhas nos controles solicitados.
