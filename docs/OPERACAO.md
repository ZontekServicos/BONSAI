# Operação e implantação

## Contrato de dados

O JSON original está preservado em `contracts/system-contract.json`. UUID é string; Date é `YYYY-MM-DD`; Timestamp é ISO 8601 com timezone; Decimal é string com duas casas. Valores monetários são calculados em NUMERIC no PostgreSQL ou centavos BigInt no servidor. O React usa Number somente para apresentação monetária.

`UserRecord` inclui `password_hash` apenas para persistência. As respostas usam `User`, sem hash. As extensões já previstas no schema original permanecem identificadas nos tipos. Conforme o SQL fornecido, `metodo_pagamento` de mensalidade é `null` até o recebimento; depois usa um dos métodos documentados. Esta nulabilidade é um refinamento explícito do `String` no JSON, necessário para não inventar método em uma cobrança pendente.

Migração 0002 acrescenta família de sessão, idempotência, limites de requisições e histórico de estoque. Migração 0003 acrescenta a extensão `pg_trgm` e índices para busca por nome/e-mail. As entidades originais são preservadas. `ajuste` de estoque recebe uma variação com sinal: `-2` retira duas unidades. Venda com total zero registra item/estoque sem lançamento de caixa, pois o schema proíbe lançamento de valor zero.

Implementação usa SQL parametrizado via `pg`, validação estrita Zod e um executor de migrações com checksum e lock PostgreSQL. Kysely, TypeBox e node-pg-migrate da proposta não são dependências necessárias. O mapa de endpoints e o schema fornecidos são preservados. Endpoints sem paginação no mapa conservam esse formato; os históricos paginados limitam páginas a 100 itens.

## Railway

O Dockerfile é construído da **raiz do repositório**, não de `apps/api`. A configuração padrão serve React e API pelo mesmo domínio, permitindo cookie SameSite=Strict sem dependência de cookies de terceiros.

1. Crie PostgreSQL e um serviço da aplicação, usando `railway.json`.
2. Defina `DATABASE_URL` pela referência privada do PostgreSQL; `JWT_ACCESS_SECRET` e `JWT_QR_SECRET` diferentes, cada um com ao menos 32 bytes aleatórios; `CORS_ORIGIN` com a origem HTTPS exata, sem `/` final; `DIAS_CARENCIA=5`; `NODE_ENV=production`; `SERVE_WEB=true`. Railway fornece `PORT`.
3. O pre-deploy executa `node apps/api/dist/migrate.js`. Nunca altere uma migração aplicada: o checksum impede isso. Se o banco já foi criado manualmente com o schema inicial, valide sua equivalência e faça um baseline controlado antes do primeiro pre-deploy; o executor não assume equivalência silenciosamente.
4. `/health` consulta o banco. Após a implantação, crie o administrador e valide login, matrícula, presença e recebimento no domínio real.
5. Crie um serviço cron com o mesmo código, variáveis do banco e config `railway.cron.json`. Ele executa às 06:00 UTC (03:00 em São Paulo), encerra o processo e usa lock para evitar sobreposição. Implante o cron somente depois das migrações da API.

Se preferir web e API separados, use `SERVE_WEB=false` na API e `VITE_API_URL=https://DOMINIO-API/api/v1` no build do web. `CORS_ORIGIN` deve ser a origem do web. Com origens em sites diferentes, `COOKIE_SAME_SITE=none` exige HTTPS; navegadores que bloqueiam cookies de terceiros ainda podem impedir renovação. Prefira domínio compartilhado ou proxy para `/api`.

Segredos e DATABASE_URL ficam apenas nas variáveis de servidor. Nunca em `VITE_*`. O pool usa no máximo `PG_POOL_MAX` conexões (10 por padrão), mais uma conexão dedicada ao LISTEN por réplica. Provisione também conexões para cron e migrações. LISTEN precisa de conexão PostgreSQL direta, sem pool em modo transaction.

Referências oficiais consultadas: [pre-deploy](https://docs.railway.com/deployments/pre-deploy-command), [cron e timezone UTC](https://docs.railway.com/cron-jobs), [configuração como código](https://docs.railway.com/config-as-code/reference).

## Primeiro administrador

Não existe cadastro público de administrador nem senha padrão. Execute o comando com acesso ao banco do ambiente escolhido. A entrada JSON vai por stdin, não como argumento de processo. Exemplo PowerShell local, sem registrar a senha no histórico:

```powershell
$adminEmail = Read-Host 'E-mail do administrador'
$adminName = Read-Host 'Nome do administrador'
$adminSecret = Read-Host 'Senha (mínimo 12 caracteres)' -AsSecureString
$adminCredential = [PSCredential]::new($adminEmail, $adminSecret)
@{ email=$adminEmail; nome=$adminName; senha=$adminCredential.GetNetworkCredential().Password } |
  ConvertTo-Json -Compress |
  node --env-file=.env apps/api/dist/bootstrap-admin.js
Remove-Variable adminCredential, adminSecret
```

No Railway, execute `node apps/api/dist/bootstrap-admin.js` dentro de um shell com as variáveis do serviço e forneça o JSON pelo stdin. Use a senha temporária inicial do aluno somente no cadastro; ela não é retornada nem armazenada no navegador.

## Cobrança e inadimplência

- `BILLING_ENABLED=false` por padrão: o cron ainda processa inadimplência, fecha presenças abandonadas e limpa sessões/limites antigos.
- Para habilitar geração mensal, configure `BILLING_ENABLED=true`, `BILLING_AMOUNT` (ex. `150.00`) e `BILLING_DUE_DAY` (1 a 31). O dia é limitado ao último dia de cada mês.
- A rotina garante as cobranças do mês atual em toda execução e, a partir do dia 25, também as do mês seguinte. Vencimentos já existentes são ignorados. Mudança no dia padrão pode criar outro vencimento na mesma competência: revise cobranças existentes antes dessa mudança, pois a unicidade do contrato é por aluno e data de vencimento.
- Alunos inativos não recebem novas cobranças. Não há plano individual persistido no contrato; valores individuais podem ser passados no lote administrativo. Cobranças já criadas não são reescritas pelo cron.
- Bloqueia quando `vencimento + carência < hoje` em São Paulo. Inadimplência não impede login; impede emissão/validação da carteirinha e check-in. Pagamento recalcula a situação imediatamente.
- A automação gera registros de cobrança. Não há gateway bancário, emissão automática de Pix/boleto, envio de notificações ou débito em conta no contrato. Recebimento é confirmado pela recepção com o método usado.
- O leitor da recepção deve fornecer o conteúdo do QR no campo de validação (leitor físico ou aplicativo). A interface não solicita acesso à câmera.

## Git

Repositório: https://github.com/ZontekServicos/BONSAI. Branch principal: `main`. Para obter o projeto em outra máquina:

```powershell
git clone https://github.com/ZontekServicos/BONSAI.git
Set-Location BONSAI
```

Para publicar alterações depois de validar o build e os testes:

```powershell
git add .
git status --short
git diff --cached --stat
git commit -m "feat: implement Bonsai ERP API and integrate React"
git push origin main
```

`.env`, logs, dados temporários de teste, node_modules e builds estão ignorados. `.env.example` é versionado sem credenciais reais. A CI executa build, testes com PostgreSQL 18 e auditoria das dependências de produção.
