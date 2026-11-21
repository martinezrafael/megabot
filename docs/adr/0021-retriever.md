# ADR 0021 — Retriever: busca por tenant, limites e teste de relevância

- **Status:** Aceita
- **Data:** 2026-11-21
- **Contexto da task:** T2.3 (Sprint 2)

## Contexto

A T2.2 deixou a base de conhecimento ingerida: trechos com embedding de 1536 dimensões, índice HNSW e RLS por tenant. Falta a outra metade: dada uma pergunta do cliente, achar os trechos que respondem a ela e entregar um contexto para o prompt do agente (T2.4).

Três coisas precisavam de decisão: como garantir que um tenant nunca veja a base do outro; como limitar o tamanho do contexto (que é o que determina custo e latência de cada resposta); e como saber se a busca está devolvendo o trecho certo — sem isso, qualquer mudança na busca é no escuro.

## Decisão

**Um pacote `@megabot/retrieval`, sem framework.** Recebe o provedor de embeddings, o logger e as métricas por injeção, e a função de busca também (`SearchChunks`), que por padrão é a `searchKnowledgeChunks` do `@megabot/database`. Worker e API usam o mesmo retriever com a mesma configuração.

**Isolamento em duas camadas.** `tenantId` é obrigatório e validado antes de qualquer consulta, e a busca roda dentro de `withTenant`, com `FORCE ROW LEVEL SECURITY` no banco. A primeira camada é o código; a segunda não depende dele. Um teste repete as 15 perguntas de amostra num segundo tenant, que tem a base vazia, e exige resultado vazio.

**Dois limites, não um.** Teto de trechos (`maxChunks`) **e** orçamento de tokens (`maxTokens`). Só contar trechos não controla custo, porque trecho é de tamanho variável; só contar tokens deixa passar um contexto com trinta fragmentos minúsculos. Junto com eles: similaridade mínima (abaixo dela o trecho é ruído e atrapalha mais do que ajuda) e um teto por fonte, para um documento só não ocupar o contexto inteiro. O último trecho entra cortado se couber pela metade, em fim de frase quando possível.

**Contagem real de tokens, carregada preguiçosamente.** `gpt-tokenizer` em vez de heurística: as fórmulas do tipo "caracteres ÷ 4" erram até 19% para menos em português, e errar para menos num orçamento significa estourar o contexto do modelo. A tabela do tokenizador custa ~25 MB de memória, então ela só é carregada na primeira busca — processos que nunca buscam não pagam nada.

**Teste de relevância com provedor léxico determinístico.** Um corpus de 12 trechos e 15 perguntas (3 delas ambíguas de propósito), com o trecho esperado para cada pergunta, rodando contra Postgres + pgvector de verdade. Os embeddings vêm de um provedor léxico próprio (sem acento, sem stopword, radical de 6 letras, hash em 1536 dimensões, normalizado), não do modelo: assim o teste é reprodutível, roda no CI sem chave de API e não cobra dinheiro a cada execução. As metas (75% de acerto em 1º lugar, 85% entre os 3 primeiros) ficam uma pergunta abaixo do resultado atual (87% / 93%).

## Consequências

O contexto do agente tem custo previsível: no padrão, no máximo 6 trechos e 1200 tokens por pergunta. Mudanças na busca (outro limiar, outro tamanho de trecho, outro índice) passam a ter um número para comparar antes e depois.

O teste de relevância mede a **nossa** mecânica — ordenação, limiar, diversidade, limites, isolamento —, não a semântica do modelo. Ele não pega regressão de qualidade causada por troca de modelo de embedding: isso se confere com `pnpm --filter @megabot/worker knowledge:search -- --tenant <uuid> "pergunta"`, que usa o provedor de verdade e imprime similaridade, tokens e custo.

Os limites estão na configuração do worker (`RETRIEVAL_*`), então dão para ajustar em produção sem recompilar — ao preço de serem mais um grupo de variáveis para documentar e manter.

## Decisões pendentes

Reordenação por um segundo modelo (_rerank_) ficou de fora: só vale decidir quando houver base real de cliente para medir. Busca híbrida (vetor + texto, `tsvector`) também: a pergunta ambígua que o provedor léxico não acha hoje é exatamente o caso que a busca híbrida resolveria, e a decisão fica para quando existir volume de perguntas reais.
