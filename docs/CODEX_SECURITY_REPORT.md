# Auditoria Codex Security — BONSAI

Estado: **parcial; sem aprovação de produção**. Auditoria iniciada em
14/11/2026 e retomada em 15/11/2026 (America/Sao_Paulo).

## Escopo e rastreabilidade

Repositório `ZontekServicos/BONSAI`, revisão-base
`49cb6029a1700f8e71bd417289022ed49795b089`, incluindo alterações locais existentes
de interface e contas de demonstração. Cada execução possui um snapshot próprio;
o SHA do Git sozinho não representa essas alterações ainda não commitadas.

Ferramenta oficial `@openai/codex-security@0.10.0`, plugin 0.1.95, modelo
`gpt-5.6-sol`, autenticação ChatGPT já válida, programa Standard. Não foi utilizado
Daybreak, modo mock ou desativação de salvaguardas.

| Execução | Identificador | Resultado |
| --- | --- | --- |
| Standard, runtime incluído 0.167.1 | `fab601e3-5ff2-44d8-9aff-fd94b981a459` | Falhou: encerramento nativo com código 3221225477. Inventário de 77 arquivos; revisão não concluída. |
| Standard, runtime oficial 0.169.0 | `0bd26db5-e6ce-485c-9637-824af88e23e8` | Falhou: limite de uso da conta. Inventário de 78 arquivos; sem relatório final ou remediação disponível. |
| Deep, runtime oficial 0.169.0 | `bed71cbb-32b7-4a4f-a097-3f61edaf97f5` | Falhou na preparação: subprocessos não reconheciam o checkout devido à propriedade Git. Corrigido com `safe.directory` restrito à pasta BONSAI. |
| Deep, runtime oficial 0.169.0 | `75905a85-e57d-4cb0-8aee-9573dc0ded75` | Falhou por limite de uso da conta após registrar dois candidatos. Inventário de 81 arquivos; nenhuma rodada independente concluída. Consolidação/deduplicação final pendente. |

As duas execuções Standard falhas retornaram `findings: []`, mas
`hasReportableFindings: null` e `remediationAvailable: false`. Isso representa
ausência de resultado concluído, **não** ausência de vulnerabilidades.

## Candidate Findings

Os dois candidatos abaixo foram preservados pelo Deep Scan, embora a execução
global não tenha concluído. A evidência é estática: os workflows novos ainda não
foram ativados, e não houve exploração ou acesso a uma chave real.

| ID | Origem / severidade | Achado e condição | Situação |
| --- | --- | --- | --- |
| BONSAI-SEC-001 | Codex Security / High, confiança Medium | `cand-pr-secret-exposure` (`occ_5b519495c7d3469f99b2f30b`): um colaborador pode alterar o workflow de um PR interno e obter o secret de repositório antes da revisão. Afeta `.github/workflows/codex-security.yml`. | Mitigação aplicada no código: ambos os jobs com chave exigem `environment: codex-security`. **Pendente de configuração remota:** required reviewers, prevent self-review, sem bypass, chave exclusiva do Environment. `cs verify-fix` considerou a conclusão inconclusiva sem essa evidência externa. |
| BONSAI-SEC-002 | Codex Security / Medium, confiança Medium | `cand-pr-scan-concurrency` (`occ_6eea963af3379c740d911d71`): `github.run_id` torna o grupo de concorrência único; pushes sucessivos mantêm scans antigos consumindo recursos. Afeta `.github/workflows/codex-security.yml`. | Corrigido no código e confirmado estaticamente pelo `cs verify-fix`: grupo estável por PR com separação de metadados, cancelamento de antigos e checagem de SHA mantida. Limites estimados de custo adicionados; não são teto financeiro obrigatório. |
| BONSAI-SEC-003 | Revisão complementar / Medium | Edição somente de título/descrição pula o gate sob o mesmo nome obrigatório. GitHub considera jobs pulados bem-sucedidos. | Corrigido: prefixo `metadata /` nesses eventos. Patch proposto pelo `cs patch`, aplicado pelo editor do workspace após a ferramenta recusar escrita em sandbox somente leitura. `cs verify-fix --verification-mode static` retornou `fixed`; actionlint aprovado. |

BONSAI-SEC-003 não é apresentado como descoberta do Deep Scan. Sua evidência de
plataforma está na [documentação de status checks do GitHub](https://docs.github.com/en/pull-requests/reference/status-checks).
Não houve teste real de merge no GitHub. A primeira solicitação de patch de
BONSAI-SEC-001 também encontrou `ERR_STREAM_PREMATURE_CLOSE` no runtime; as
tentativas e limitações são mantidas, sem tratá-las como correções aprovadas.

Os patches dos candidatos foram solicitados ao `cs patch` em cópia isolada. A
ferramenta recusou a escrita em sandbox somente leitura. Sua proposta posterior
incluía `pull_request_target`, evento não suportado pela Action fixada. Esse trecho
foi substituído pela proteção por Environment; a correção de concorrência foi
adaptada para preservar scans durante edições de metadados. As alterações foram
aplicadas pelo editor autorizado do workspace e passaram no actionlint e no
typecheck. Não houve modificação da implementação do ERP nesta auditoria.

O resultado conjunto da verificação estática dos candidatos 001/002 foi
`inconclusive` exclusivamente pela dependência externa de 001; o texto da
verificação confirma 002 como remediado. Não equivale a aprovação de produção.
Os candidatos originais, com localizações do snapshot anterior aos patches,
estão em [security/candidate-findings.json](security/candidate-findings.json).

## Validação complementar

- **JWT:** chave de acesso separada da chave de carteirinha; acesso emitido com
  validade de 15 minutos, QR com 90 segundos, verificação de algoritmo, emissor e
  público. A autorização recarrega papel/status do banco e exige uma família de
  sessão válida. Testes cobrem expiração, assinatura errada, algoritmo diferente,
  contexto incorreto e tentativa de elevar o papel no payload.
- **Sessões:** Argon2id, refresh opaco armazenado por hash, rotação, revogação por
  replay, logout, alteração de senha e inativação. Cookies HttpOnly e SameSite;
  operações com cookies exigem a origem exata.
- **CORS/headers:** origem única configurada, sem wildcard; CSP com bloqueio de
  frames, `nosniff` e respostas de API sem cache. A configuração real do Railway,
  seus secrets e os headers do domínio de produção não foram acessados.
- **IDOR/RBAC:** o contrato possui apenas `admin` e `aluno`. “Professor” é o nome
  da conta demonstrativa com papel `admin`, incluindo autoridade financeira.
  Não há papel docente restrito separado. Testes verificam isolamento entre
  alunos, rejeição de parâmetros extras e proteção dos módulos administrativos.
- **SQL:** consultas dos módulos revisados usam parâmetros; interpolação de
  identificadores/ordenação usa escolhas fixas no código. Teste de payload SQL
  em busca não amplia os resultados. Não foi identificado caminho de injeção
  nessa revisão complementar.
- **Demonstração:** credenciais conhecidas foram verificadas como ausentes de
  `dist` e `apps/api/dist` após o build de produção. Essa verificação não prova
  ausência de contas demo em algum banco remoto.

## Regressão e automação

Na execução de 14/11: build aprovado, 21 testes de integração com PostgreSQL 18
aprovados, typecheck aprovado e auditoria das dependências de produção sem
vulnerabilidades conhecidas reportadas. Os testes incluem concorrência de vendas,
estoque, pagamentos, idempotência, carência, bloqueio de carteirinha, geração de
mensalidades, eventos de presença e revogação de sessões.

Os workflows preparados passaram no `actionlint 1.7.12`. A Action oficial é fixada
por SHA. O gate exige análise concluída, política aprovada, relatório pronto e
revisão exata do PR. Não foi feita execução real no GitHub nem configuração remota
de secret/proteção da branch. Consulte [CODEX_SECURITY.md](CODEX_SECURITY.md).

## Limites da conclusão

Uma auditoria de código e seus testes não certificam a infraestrutura implantada.
A aprovação continua pendente de scan completo, triagem e verificação dos patches
eventuais, além de secrets, HTTPS, permissões do banco e regras de merge realmente
configurados no ambiente de produção.
