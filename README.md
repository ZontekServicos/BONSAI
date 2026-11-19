# BONSAI / Fight Control

ERP de academia: React 19 + Vite 8 + Tailwind 4; API Fastify 5 + PostgreSQL 15 ou superior.

- Contrato original: [contracts/system-contract.json](contracts/system-contract.json).
- Tipos públicos e de persistência: [src/types/contract.ts](src/types/contract.ts).
- Schema inicial: [database/schema.sql](database/schema.sql).
- Endpoints e regras: [docs/ARQUITETURA.md](docs/ARQUITETURA.md).
- Operação, implantação e Git: [docs/OPERACAO.md](docs/OPERACAO.md).
- Auditoria e limites de validação: [docs/AUDITORIA.md](docs/AUDITORIA.md).

## Desenvolvimento

Requer Node 22.18+ (ou 24.11+) e pnpm 10.34.3. Configure um PostgreSQL local. No PowerShell:

```powershell
pnpm.cmd install --frozen-lockfile
Copy-Item .env.example .env
# Edite .env: conexão do banco, origem da interface e dois segredos aleatórios.
pnpm.cmd run build:api
node --env-file=.env apps/api/dist/migrate.js
pnpm.cmd run dev:api
```

O Vite existente continua em 8443 e encaminha `/api` para `localhost:3001`. Se não estiver rodando, `pnpm.cmd dev`. Não configure `VITE_API_URL` no desenvolvimento com proxy. Em produção, crie o primeiro administrador pelo procedimento de operação.

### Contas de demonstração (somente desenvolvimento)

Para testar o controle de acesso, `pnpm demo:seed` cria (ou redefine) contas reais no banco do `.env`:

| Perfil | E-mail | Senha |
|---|---|---|
| Gestor (`admin`) | `gestor@bonsai.demo` | `Bonsai@Gestor2026` |
| Professor (`professor`) | `professor@bonsai.demo` | `Bonsai@Professor2026` |
| Aluno adulto (`aluno`) | `aluno@bonsai.demo` | `Bonsai@Aluno2026` |
| Aluno menor, com responsável | `menor@bonsai.demo` | `Bonsai@Aluno2026` |

Com `VITE_DEMO_LOGIN=true` no `.env`, a tela de login mostra os botões **Gestor**, **Professor** e **Aluno** no `vite dev`. O login passa pela API normal (Argon2id + JWT + RBAC). O script recusa `NODE_ENV=production` e fica fora do `build:api`. Os botões e as credenciais são removidos do bundle em `vite build`, mesmo com a flag ligada.

## Verificação

```powershell
pnpm.cmd build
# Crie uma base separada chamada bonsai_test, nunca a base da aplicação.
$env:TEST_DATABASE_URL = 'postgresql://USUARIO:SENHA@localhost:5432/bonsai_test'
pnpm.cmd test
pnpm.cmd audit
```

Os testes criam um schema aleatório na base `bonsai_test` e removem apenas esse schema ao terminar. Exercitam a API com PostgreSQL real, incluindo requisições concorrentes. O usuário de teste precisa de permissão para criar schemas e as extensões `citext`/`pgcrypto`/`pg_trgm`. Execute o build antes dos testes, pois a suíte também verifica a entrega do React compilado.

`pnpm.cmd audit:queries`, com o mesmo `TEST_DATABASE_URL`, executa EXPLAIN ANALYZE em um schema temporário com 5.000 alunos e 10.000 lançamentos. O resultado é salvo em `docs/QUERY_AUDIT.json`.

## Estrutura

```text
apps/api/src/       configuração, autenticação, HTTP e módulos do servidor
apps/api/test/      testes de integração com PostgreSQL
contracts/         contrato de interface original
database/          schema inicial e migrações aditivas
src/components/    telas React por domínio
src/lib/           cliente HTTP, sessão e stream de presença
src/types/         tipos compartilhados
docs/              arquitetura, operação e auditoria
```
