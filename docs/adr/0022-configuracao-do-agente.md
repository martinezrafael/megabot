# ADR 0022 — Configuração do agente: versionamento append-only

- **Status:** Aceita
- **Data:** 2026-11-21
- **Contexto da task:** T2.4 (Sprint 2)

## Contexto

O agente precisa saber como se chamar, em que tom falar, o que pode fazer e o que não pode. Isso é configuração
do cliente, editável por ele na tela — e configuração editável de atendimento é exatamente o tipo de coisa que
alguém altera numa sexta-feira e quer desfazer na segunda. A task pede histórico de versões e rollback.

A pergunta de projeto é como guardar versões sem criar estados inválidos. O jeito comum (uma tabela de
configuração atual + uma de histórico, ou uma coluna `ativa`) abre espaço para dois problemas clássicos: duas
versões ativas ao mesmo tempo, ou nenhuma.

## Decisão

**Uma tabela, append-only, e a ativa é a de maior número.** `agent_configs` guarda todas as versões. Salvar
insere uma linha com `version = último + 1`; nada é atualizado nem apagado. Não existe coluna `ativa`, então
não existe o estado de duas ativas (ou de nenhuma): a ativa é `MAX(version)` do tenant, por definição.

**Rollback é um evento, não uma reescrita.** Restaurar a versão 1 não volta ponteiro nenhum: copia o conteúdo
da 1 para uma versão nova, com `restored_from_version = 1`. Quem olha o histórico depois vê o que aconteceu,
inclusive que houve um rollback e de onde. Restaurar a versão que já está no ar é recusado (409), porque criar
uma cópia idêntica da ativa só suja o histórico.

**A numeração é serializada por um lock de aviso por tenant.** `MAX(version) + 1` é uma corrida: em
READ COMMITTED, duas transações simultâneas leem o mesmo máximo. A transação começa com
`pg_advisory_xact_lock(hashtext('agent_configs'), hashtext(tenant_id))`, o que serializa os salvamentos de
**uma** empresa e de mais nenhuma; o lock morre no commit. O índice único `(tenant_id, version)` fica como
rede: se o lock falhar, o banco recusa a duplicata e a operação é repetida em vez de gravar errado. Um teste
salva cinco versões em paralelo e cobra numeração sem repetição e sem buracos — com três tentativas e sem
lock, ele falhava.

**O catálogo de ferramentas vive no código, não no banco.** `packages/database/src/agent-config.ts` lista as
ferramentas com `label`, `description` e `status`. Ferramenta nova é uma linha ali, sem migration. O `status`
resolve um problema honesto: hoje só a consulta à base de conhecimento existe de verdade. As outras aparecem
na tela como "em breve", desabilitadas, e o `PUT` recusa habilitá-las — a configuração não promete ao cliente
um comportamento que o produto não tem.

**Isolamento nas duas camadas de sempre.** `tenant_id` vem da sessão (nunca do corpo ou da URL) e a tabela tem
RLS com `FORCE ROW LEVEL SECURITY`. O histórico de uma empresa não é alcançável por outra nem por id direto, e
cada empresa tem a sua numeração, começando do 1.

## Consequências

O histórico é confiável por construção: não existe caminho no código que perca uma versão, porque não existe
`UPDATE` nem `DELETE` nessa tabela. O custo é espaço — uma linha por salvamento, com o texto inteiro repetido.
Para configuração editada por gente (dezenas de versões por ano, não milhares), isso é irrelevante perto de
poder auditar e desfazer.

A tela e o agente leem sempre a mesma coisa (`getActiveAgentConfigOrDefault`), e a empresa que nunca salvou
recebe um padrão explícito marcado com `version: 0`, em vez de `null` espalhado pelo código de quem consome.

Como o rollback cria versão, o número da versão cresce também quando se "volta atrás" — a versão 5 pode ser
idêntica à 2. É o preço de não reescrever histórico, e o rótulo "versão 5 · restaurada da 2" existe na tela
justamente para isso não confundir.

## Decisões pendentes

Rascunho (editar sem publicar) ficou de fora: precisaria de um estado `draft` e, aí sim, de um ponteiro de
versão ativa — o que traz de volta o estado inválido que esta decisão evita. Só vale quando houver pedido real.

Diferença entre duas versões lado a lado (_diff_) também ficou para depois: hoje a tela mostra o conteúdo
completo de uma versão por vez, o que resolve "o que eu tinha antes?" sem código de comparação.
