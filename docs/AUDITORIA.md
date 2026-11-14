# Auditoria técnica — 14/11/2026

Implementação validada localmente com PostgreSQL 18 e Node 24.13.1. O contrato original, o schema e os endpoints foram usados como referência. A API passou em 18 testes de integração, o build de produção foi gerado e a auditoria de dependências terminou com zero avisos conhecidos. A implantação no Railway não foi executada nesta sessão.

## Segurança: achados tratados

| ID | Severidade inicial | Achado e tratamento | Evidência |
|---|---|---|---|
| SEC-01 | Alta | O protótipo validava credenciais fixas no navegador e incluía senhas em objetos locais. Substituído por autenticação na API, Argon2id, JWT de 15 minutos e refresh opaco em cookie HttpOnly. | `apps/api/src/auth.ts:12`, `apps/api/src/auth.ts:57`; nenhum mock de credenciais permanece no React. |
| SEC-02 | Alta | O protótipo não tinha autorização de servidor nem isolamento de dados de aluno. Guardas consultam usuário e sessão atuais no PostgreSQL; aluno só acessa seus dados. QR e access token usam segredos e audiences distintos. | `apps/api/src/auth.ts:24`, `apps/api/src/http.ts:93`; testes de RBAC/IDOR, revogação e separação de JWT. |
| SEC-03 | Alta | Presença e alterações de cadastro eram apenas estado local. Implementados transações, restrições SQL, ordem de locks e idempotência para vendas. | `apps/api/src/modules/store.ts:199`, `apps/api/src/modules/billing.ts:200`; testes de estoque concorrente, pagamento duplo, rollback e caixa imutável. |
| SEC-04 | Crítica/Alta | A auditoria intermediária encontrou avisos em dependências diretas e transitivas. Atualizados Fastify static 10.1.11, Vite 8.3.8, Vitest 5.1.0 e tsup 9.0.0, com novo lockfile. | Auditoria final: **0 info, 0 low, 0 moderate, 0 high, 0 critical**. Os avisos críticos eram de ferramentas de teste; isso não demonstra exploração do sistema. |

Defesas verificadas:

- SQL com parâmetros; ordenação limitada a opções conhecidas. IDs, enums, datas reais, valores monetários e campos extras são validados antes da operação. Erros não retornam queries ou detalhes internos do PostgreSQL.
- Login com resposta genérica, hash fictício para e-mail inexistente e limites por IP/e-mail persistidos no banco, compartilhados entre réplicas. Limites globais por IP e usuário também persistidos.
- Refresh rotacionado, detecção de reutilização com revogação persistida da família, logout revogando JWTs dessa sessão e inativação/troca de senha revogando sessões. Origem validada em operações de cookie; CORS restrito. Secure em produção; SameSite configurável para topologia separada.
- React renderiza dados como texto, sem `dangerouslySetInnerHTML`; sem JWT em localStorage/sessionStorage. CSP, cabeçalhos Helmet e `Cache-Control: no-store` para API. Teste HTTP bloqueia acesso estático a caminhos externos à raiz.
- QR de 90 segundos; emissão, validação e check-in reconsultam dívidas. Nunca há liberação baseada apenas no claim de status. Testados limite de carência, login inadimplente e desbloqueio ao pagar.
- Operações SQL usam transações com rollback e liberação da conexão em `finally`. SSE cancela timers/listeners, encerra por expiração do JWT, revalida sessão no heartbeat, limita conexões e fecha clientes lentos. O React cancela leituras HTTP, encerra streams e remove timers/eventos ao desmontar. Isso é revisão estrutural e teste de ciclo de conexão; não substitui perfil de heap prolongado.

## Performance

- Consultas de histórico paginadas com teto de 100 registros; busca React com debounce de 250 ms. Contagens não precisam da ordenação usada na listagem.
- Índices parciais já existentes atendem presença aberta e mensalidades; migração 0003 acrescenta busca GIN/trigram para nome/e-mail. Dinheiro permanece NUMERIC/string; cálculo de carrinho usa BigInt.
- Pool por réplica limitado a 10 conexões por padrão, timeout de conexão de 5 s e statement timeout de 15 s. LISTEN usa conexão dedicada. Cron usa lock e processamento no banco; não depende de timers na API.
- Build React: aproximadamente **248,79 kB JS / 78,35 kB gzip** e **26,69 kB CSS / 7,03 kB gzip**. Sem sourcemaps públicos no build de produção.

EXPLAIN ANALYZE local em schema isolado, depois de VACUUM ANALYZE, com 5.000 alunos, 5.000 presenças (5 abertas), 5.000 mensalidades e 10.000 lançamentos:

| Consulta | Execução observada | Índices escolhidos |
|---|---:|---|
| Presentes agora | 0,117 ms | `ix_attendance_presentes`, PKs de perfil e usuário |
| Pendências de um aluno | 0,023 ms | `uq_financeiro_competencia` |
| Busca por nome/e-mail | 0,080 ms | `ix_users_nome_search`, `ix_users_email_search` |
| Caixa do dia | 0,090 ms | `ix_cash_flow_type_data` |

Resultado reproduzível em [QUERY_AUDIT.json](QUERY_AUDIT.json); comando `pnpm audit:queries`. São medições individuais do banco local, com cache aquecido, sem custo HTTP/rede. Não são percentis de carga nem promessa de latência do Railway. Antes de VACUUM, o otimizador preferiu varredura na busca (4,201 ms); isso reforça a importância de autovacuum/analyze em produção.

## Validações e limites

- `pnpm build`: TypeScript front/back e builds Vite/Node concluídos.
- `pnpm test`: 18 testes com PostgreSQL real, incluindo concorrência, isolamento, serialização do contrato, rotação/reuso de sessão, corrida refresh/logout, carência, cobrança em fevereiro bissexto, matrícula com mensalidades, graduação, estoque, caixa, relatórios, arquivos estáticos e LISTEN/SSE.
- Migrações executadas duas vezes em base nova: primeiro aplicou 0001/0002/0003; segundo não reaplicou nenhuma. Checksum e advisory lock protegem execução repetida.
- `pnpm audit`: nenhum aviso conhecido após atualizações; resultado em [DEPENDENCY_AUDIT.json](DEPENDENCY_AUDIT.json). O registro de advisories muda com o tempo.
- Não havia acesso a projeto Railway, domínio, variáveis de produção ou remoto GitHub informado. Dockerfile, configuração de deploy/cron, CI e instruções estão entregues; **imagem Docker e ambiente Railway ainda precisam ser executados/validados nesse ambiente**.
- Não houve teste visual automatizado em navegador nem teste de carga sustentada. Foram verificados o build e a entrega HTTP do HTML/CSP. Valide layout móvel, interação com leitor QR, cookies no domínio real e volumes/conexões do plano antes de operar.
- Geração automática de mensalidades permanece desativada até definir e habilitar a política de cobrança. Integração com gateway bancário, envio de mensagens e leitura por câmera não fazem parte do contrato implementado.

Não foi identificado achado crítico ou alto pendente no escopo revisado. Essa conclusão é limitada às verificações descritas; não constitui certificação de segurança ou disponibilidade.
