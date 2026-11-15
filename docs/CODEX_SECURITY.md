# Codex Security no BONSAI

## Ferramenta e autenticação

Pacote oficial utilizado: `@openai/codex-security@0.10.0` (`cs`). O scanner inclui
seu próprio plugin. O programa utilizado é **Standard**; Daybreak exige acesso
específico da conta e não foi habilitado.

```powershell
npm install --global @openai/codex-security@0.10.0
cs login
cs login status
cs scan . --auth chatgpt --cyber-access-program standard --headless
cs scan . --auth chatgpt --cyber-access-program standard --mode deep --workers 1 --subagents 0 --max-discovery-runs 4 --stop-after-no-new 2 --max-time 30 --headless
```

O último comando limita a descoberta a 30 minutos e até quatro rodadas; esse
limite deve aparecer no relatório de cobertura. Deep Scan repete a descoberta e
deduplica resultados; isso não prova ausência de vulnerabilidades.

No Windows, se o Python recém-instalado ainda não estiver no PATH:

```powershell
$env:PYTHON = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe'
```

O runtime 0.167.1 incluído no pacote apresentou falha nativa nesta máquina. Para
selecionar explicitamente o Codex CLI oficial 0.169.0 instalado pelo npm:

```powershell
npm install --global @openai/codex@0.169.0
$env:CODEX_CLI_PATH = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe'
```

O status real de cada tentativa está em [CODEX_SECURITY_REPORT.md](CODEX_SECURITY_REPORT.md).
Um login já válido pode ser reutilizado; não é necessário substituir credenciais.
Não coloque tokens ou chaves no repositório, na conversa ou em arquivos de relatório.

## Achados e patches

Use o identificador retornado pelo scan, evitando confundir a revisão inicial com
uma execução posterior:

```powershell
cs scans list
cs scans show ID_DO_SCAN
cs scans logs ID_DO_SCAN
cs patch --scan ID_DO_SCAN --severity low --auth chatgpt --assess-patch-risk
cs verify-fix --scan ID_DO_SCAN --severity low --auth chatgpt
pnpm build
# TEST_DATABASE_URL deve apontar para um banco descartável chamado bonsai_test.
pnpm test
pnpm audit --prod --audit-level=high
```

Revise cada diff e sua evidência de exploração, inclusive impactos em cobranças,
estoque, pagamentos e bloqueio da carteirinha. Não aplique patches gerados para
outra revisão. Uma falha do scanner ou da verificação deixa a auditoria pendente.
Execute um novo scan completo depois das correções. Os relatórios brutos ficam
no estado privado da ferramenta, fora do checkout; não publique automaticamente
logs ou provas que possam incluir dados sensíveis.

## GitHub Actions

Arquivos preparados:

- `../.github/workflows/codex-security.yml`: todo PR direcionado à `main`, scan
  Standard de **todo o HEAD**, inclusive código que não mudou no PR.
- `../.github/workflows/codex-security-deep.yml`: execução manual Deep da revisão
  selecionada, com até uma hora de descoberta e 90 minutos de job.
- `../.github/workflows/ci.yml`: compilação e regressões do ERP em job separado.

As Actions estão fixadas por commit; a Action oficial `action-v0.9.1` tem versão
independente do pacote CLI local 0.10.0. Credenciais são fornecidas somente ao
passo do scanner. O job não instala dependências nem executa scripts do projeto
antes dele. Upload de artefatos está desativado; o resumo e as anotações ficam na
execução do Actions. Os workflows não aplicam patches nem fazem commits.

### Ativação no repositório

1. Em **Settings → Environments**, crie **codex-security**. Configure **Required
   reviewers** com mantenedores confiáveis, **Prevent self-review** e desative
   bypass por administradores. Cadastre `CODEX_SECURITY_API_KEY` **somente como
   secret desse Environment**, com uma chave de projeto da API de escopo mínimo.
   Não mantenha uma cópia como secret de repositório ou de organização acessível
   ao BONSAI: ela permitiria contornar o Environment removendo-o do workflow.
   Login ChatGPT local não fornece a credencial do CI. O YAML referencia o
   Environment, mas não cria suas regras de proteção.
   Antes de aprovar cada execução, o revisor deve conferir a revisão exata e
   alterações no workflow, nas Actions e nos arquivos de política. CODEOWNERS
   sozinho só protege o merge e não impede vazamento antes da revisão.
   Se forem usadas restrições de branches do Environment, inclua os refs
   compatíveis com PR (`refs/pull/*/merge`) e o ref autorizado para Deep manual;
   permitir apenas `main` pode bloquear os jobs de PR.
   Confirme que o plano e a visibilidade do repositório suportam required
   reviewers; se não suportarem, mantenha a chave fora do CI até disponibilizar
   uma execução confiável equivalente.
2. Envie os workflows para o GitHub e faça uma execução real em um PR de teste.
   Falta de chave, falta de acesso ao modelo, timeout ou falha do scanner devem
   reprovar o check. O pipeline nunca converte um scan parcial em aprovação.
3. Proteja `main` com PR obrigatório e os checks **Codex Security / main** e
   **verify** do GitHub Actions. Ative **Require branches to be up to date before
   merging**, descarte aprovações antigas após novos commits e impeça bypass e
   push direto conforme as permissões da equipe.
4. Exija revisão de um responsável confiável para `.github/workflows/**` e
   documentos de política usados pelo scanner, por exemplo via CODEOWNERS e
   revisão obrigatória de code owner. Defina os responsáveis reais da equipe;
   este repositório não presume uma identidade de aprovador. Sem essa proteção,
   um autor pode tentar alterar o próprio check que aprova seu PR.

O pipeline inicia em cada PR elegível, aguarda a aprovação do Environment e
executa a análise automaticamente após essa aprovação. Isso acrescenta uma
barreira antes de disponibilizar a chave a workflows de branches internas.
Required reviewers e prevent self-review exigem um aprovador diferente de quem
iniciou a execução; uma equipe com uma única pessoa precisa definir um processo
confiável alternativo antes de habilitar o segredo.

Os limites estimados por execução são US$ 5 para PR e US$ 20 para Deep, ajustáveis
pelas variáveis `CODEX_SECURITY_PR_MAX_COST` e `CODEX_SECURITY_DEEP_MAX_COST`.
`max-cost` é uma estimativa, não um bloqueio financeiro: chamadas em andamento
podem ultrapassá-la. Configure também limites de uso/rate limit disponíveis no
provedor e alertas; não trate budgets apenas informativos como teto obrigatório.
Scans incompletos por orçamento ou timeout reprovam o gate.

Pushes sucessivos do mesmo PR compartilham o grupo de concorrência e cancelam a
execução anterior. Edições somente de título/descrição usam outro grupo e outro
nome de check (`metadata / ...`), preservando a análise do código. PRs diferentes
possuem grupos diferentes. Reexecutar uma revisão antiga pode cancelar um scan
atual; a checagem de SHA rejeita a revisão antiga, e a revisão atual deve ser
reexecutada. Isso nunca substitui o scan atual por aprovação da revisão antiga.

O gate exige `scan-status=completed`, `policy-status=passed`, `report-status=ready`
e o SHA exato do PR. Vulnerabilidades **high/critical** bloqueiam o merge; achados
low/medium continuam exigindo triagem. Para bloquear também esses níveis, altere
`fail-on-severity` para `low`. Uma revisão feita sobre o repositório inteiro não
depende da escolha de uma base de diff; a regra de branch atualizada assegura que
a revisão inclua a base exigida para merge.

PRs de forks não recebem a chave: o scan é pulado e o gate obrigatório reprova.
Uma contribuição externa precisa de revisão e promoção por um mantenedor a uma
branch confiável antes da execução com credenciais. Não use `pull_request_target`
para executar código arbitrário do fork. Merge queue (`merge_group`) não está
suportada por esta configuração/Action.

A criação de arquivos locais não ativa os secrets nem as regras do GitHub. A
configuração só estará operante depois da publicação, do cadastro da chave e de
uma execução real bem-sucedida, com as regras do Environment e da branch ativas.

## Referências oficiais

- [CLI e modos de scan](https://learn.chatgpt.com/docs/security/cli.md)
- [Referência de comandos](https://learn.chatgpt.com/docs/security/cli/reference.md)
- [Integração GitHub](https://learn.chatgpt.com/docs/security/cli/ci/github.md)
- [Action fixada utilizada](https://github.com/openai/codex-security/tree/a98b35d7eef9f85c298c86229445bb64ac427aaf/github-action)
- [Proteção de Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

No CLI `cs`, `-c` seleciona um arquivo de configuração; não use `-c daybreak=true`.
Somente com entitlement confirmado, selecione o programa correspondente por
`--cyber-access-program daybreak_blue` (ou o programa autorizado).
