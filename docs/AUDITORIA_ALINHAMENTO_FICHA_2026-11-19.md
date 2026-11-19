# Auditoria técnica final — upgrade 0005 → 0006 e níveis por modalidade

**Data:** 19/11/2026  
**Escopo:** checksum, upgrade incremental, contato de emergência, níveis, datas e atomicidade  
**Resultado geral:** **APROVADO — todos os controles passaram**

## Resumo executivo

Os bloqueios BLK-01 e BLK-02 foram corrigidos. A migração `0005` coincide byte a byte, após
normalização de fim de linha, com a versão publicada no commit `54e215e`; a nova `0006` foi aplicada
pelo migrador real sobre um banco parado na `0005`. O banco rejeitou criação direta de perfil sem
contato de emergência.

A regra de níveis também foi aprovada: Boxe não aceita faixa, não aceita nível fora da lista e grava
corretamente `avancado` com o rótulo `Avançado`; Jiu-Jitsu continua exigindo faixa e grau.

## Matriz de resultados

| ID | Controle | Resultado | Evidência |
|---|---|---|---|
| AUD-01 | Upgrade real `0005 → 0006` | **PASSOU** | Migrador validou 0001–0005 e informou somente `Applied migrations/0006_ajustes_ficha_professor.sql` |
| AUD-02 | Checksum imutável da `0005` | **PASSOU** | Esperado e obtido: `0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3` |
| AUD-03 | SQL sem contato de emergência | **PASSOU** | PostgreSQL `23514`, constraint `ck_aluno_emergencia_obrigatoria` |
| AUD-04A | Boxe com `Faixa Preta` | **PASSOU** | Rejeitado com HTTP 400 |
| AUD-04B | Boxe com nível `Expert` | **PASSOU** | Rejeitado com HTTP 400 |
| AUD-04C | Jiu-Jitsu sem faixa | **PASSOU** | Rejeitado com HTTP 400 |
| AUD-04D | Boxe com nível válido `avancado` | **PASSOU** | HTTP 201; `nivel=avancado`, `faixa=Avançado`, `graduacao_nivel=0` |
| AUD-05A | Matrícula futura | **PASSOU** | Rejeitada com HTTP 400 |
| AUD-05B | Matrícula anterior ao nascimento | **PASSOU** | Rejeitada com HTTP 400 |
| AUD-05C | Falha no grupo `termos` | **PASSOU** | HTTP 400; contagens de usuário, perfil, responsável e saúde inalteradas |

## Evidência do upgrade

O cenário independente criou um schema isolado, executou `schema.sql` até a `0005`, registrou os
checksums em `schema_migrations`, inseriu um perfil legado sem contato e então executou o
`apps/api/src/migrate.ts` atual.

Resultado:

```json
{
  "checksum_0005": {
    "expected": "0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3",
    "actual": "0d4d147d2ad0e3e4d6e9580b7b703793b7e58e31ac22ff954f15504a6d81e4b3"
  },
  "migration_0006_recorded": true,
  "legacy_profile_after_0006": {
    "ficha_pendente": true,
    "nivel": null,
    "contato_emergencia_telefone": null
  }
}
```

O migrador mantém verificação de checksum em `apps/api/src/migrate.ts:24-31` e inclui a `0006` na
sequência em `apps/api/src/migrate.ts:16-23`. A nova migração preserva alunos antigos por meio de
`ficha_pendente` em `database/migrations/0006_ajustes_ficha_professor.sql:28-39`.

## Blindagem BLK-02

Uma inserção SQL direta de perfil novo sem contato de emergência foi rejeitada:

```json
{
  "code": "23514",
  "constraint": "ck_aluno_emergencia_obrigatoria"
}
```

A constraint está em `database/migrations/0006_ajustes_ficha_professor.sql:44-58`. O trigger impede
que linhas novas se autodeclarem legadas em
`database/migrations/0006_ajustes_ficha_professor.sql:79-120`.

## Regra de modalidade

### Casos negativos

- Boxe com `faixa: "Faixa Preta"`: HTTP 400. Modalidades fora do Jiu-Jitsu usam `nivel`, não faixa.
- Boxe com `nivel: "Expert"`: HTTP 400. A enum aceita somente `iniciante`, `intermediario` e
  `avancado`.
- Jiu-Jitsu sem `faixa`: HTTP 400, mesmo com grau informado.

### Controle positivo

Boxe com `nivel: "avancado"` retornou HTTP 201 e persistiu:

```json
{
  "modalidade": "boxe",
  "faixa": "Avançado",
  "graduacao_nivel": 0,
  "nivel": "avancado"
}
```

A validação compartilhada está em `src/lib/cadastro.ts:120-169` e é aplicada ao grupo de treino em
`src/lib/cadastro.ts:183-192`. A defesa do banco está em
`database/migrations/0006_ajustes_ficha_professor.sql:59-66`; o trigger espelha o rótulo em `faixa`
em `database/migrations/0006_ajustes_ficha_professor.sql:82-86`.

## Datas e atomicidade

Matrícula futura e matrícula anterior ao nascimento retornaram HTTP 400. O banco repete as regras em
`database/migrations/0006_ajustes_ficha_professor.sql:101-114`.

O payload com `termos.aceito=false` foi rejeitado antes de iniciar persistência. As contagens das
quatro tabelas permaneceram idênticas:

```json
{
  "http_status": 400,
  "before": {
    "users": 4,
    "aluno_profile": 2,
    "responsaveis": 0,
    "historico_saude": 1
  },
  "after": {
    "users": 4,
    "aluno_profile": 2,
    "responsaveis": 0,
    "historico_saude": 1
  },
  "unchanged": true
}
```

Para falhas durante persistência, responsável, usuário, perfil e saúde continuam dentro do mesmo
`db.transaction` em `apps/api/src/modules/cadastro.ts:78-163`.

## Regressão e qualidade

- `pnpm test`: **34/34 testes aprovados**.
- `pnpm build`: typecheck, Vite e build da API aprovados.
- `pnpm lint:colors`: **12 arquivos aprovados**.
- Testes permanentes de checksum e upgrade: `apps/api/test/integration.test.ts:1180-1270`.
- Testes permanentes de emergência e modalidade: `apps/api/test/integration.test.ts:1014-1097`.

## Decisão de publicação

**APROVADO PARA COMMIT E PUSH.** Nenhum achado bloqueador permaneceu dentro do escopo solicitado.
