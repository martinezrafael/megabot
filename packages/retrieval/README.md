# @megabot/retrieval

**Busca na base de conhecimento** (_retriever_): recebe uma pergunta, acha os trechos mais parecidos **do tenant** e devolve um contexto pronto para entrar no prompt — dentro de um limite de trechos **e** de tokens. Não depende de NestJS: quem usa (worker/API) injeta o provedor de embeddings, o logger e as métricas. Segue o [ADR 0021](../../docs/adr/0021-retriever.md).

## O que tem

| Parte              | Para quê                                                                 | Arquivo            |
| ------------------ | ------------------------------------------------------------------------ | ------------------ |
| `Retriever`        | O fluxo inteiro: embedding da pergunta → busca → seleção → contexto      | `src/retriever.ts` |
| `RetrievalLimits`  | Limites (trechos, tokens, similaridade mínima, trechos por fonte)        | `src/types.ts`     |
| `loadTokenCounter` | Contagem **real** de tokens (`gpt-tokenizer`), carregada só quando usada | `src/tokens.ts`    |
| `truncateToTokens` | Corta um texto no limite de tokens, respeitando fim de frase/palavra     | `src/tokens.ts`    |
| `RETRIEVAL_METRIC` | Nomes das métricas emitidas                                              | `src/retriever.ts` |

## Como usar

```ts
import { createOpenAiProvider } from '@megabot/ai';
import { Retriever } from '@megabot/retrieval';

const retriever = new Retriever({
  embedder: createOpenAiProvider(config.ai),
  limits: { maxChunks: 6, maxTokens: 1200, minSimilarity: 0.35 },
  logger,
  metrics,
});

const { chunks, context, tokens, stats } = await retriever.retrieve({
  tenantId,
  query: 'qual o prazo de entrega?',
});
```

`context` já vem numerado, para o modelo poder citar a fonte:

```
[1] Política de trocas — Prazo
O prazo para solicitar troca é de 30 dias...

[2] Entrega e frete — Prazos
...
```

Se nada na base responde à pergunta, `chunks` vem vazio e `context` vem `''` — **não** é erro. Quem chama decide o que fazer (responder sem contexto, encaminhar para humano, etc.).

## O fluxo, em ordem

1. **Valida o tenant.** Sem `tenantId` o retriever lança erro antes de qualquer consulta: sem tenant não existe busca.
2. **Limita a pergunta** a 2000 caracteres (uma pergunta maior que isso é quase sempre texto colado por engano, e embedding custa por token).
3. **Gera o embedding** da pergunta com o mesmo modelo e as mesmas 1536 dimensões usados na ingestão (T2.2). Vetor de dimensão diferente não pode ser comparado.
4. **Busca candidatos** com `searchKnowledgeChunks`, que roda `ORDER BY embedding <=> $1` com **RLS ligada** — a consulta só vê as linhas do tenant, mesmo se o código errar o filtro.
5. **Seleciona** entre os candidatos: corta os pouco parecidos, limita trechos por fonte (para não gastar o orçamento todo com uma fonte só) e vai somando até o limite de tokens, cortando o último trecho se ele couber pela metade.
6. **Monta o contexto** numerado e emite log e métricas.

## Limites

| Limite           | Padrão | Para quê                                                            |
| ---------------- | ------ | ------------------------------------------------------------------- |
| `maxChunks`      | 6      | Teto de trechos no contexto                                         |
| `maxTokens`      | 1200   | Orçamento de tokens do contexto (o que controla o custo de verdade) |
| `minSimilarity`  | 0.35   | Abaixo disso o trecho é ruído: é melhor não mandar nada             |
| `maxPerSource`   | 3      | Diversidade: evita que um documento ocupe o contexto inteiro        |
| `candidateLimit` | 24     | Quantos candidatos o banco devolve antes da seleção                 |
| `maxChunkTokens` | 600    | Teto por trecho; acima disso o trecho entra cortado                 |

No worker eles vêm da configuração (`RETRIEVAL_*` no `.env`), então dão para ajustar sem recompilar. `retrieve()` também aceita `limits` por chamada, que tem prioridade.

## Observabilidade

Log `retrieval.query` com `tenant_id`, contagens, `top_similarity`, modelo, custo e latência. Métricas: `retrieval_requests_total` (`outcome: hit|empty|error`), `retrieval_chunks_returned_total`, `retrieval_context_tokens_total`, `retrieval_latency_ms` e `retrieval_chunks_dropped_total` (`reason: below_threshold|per_source|budget`).

**A pergunta e o conteúdo dos trechos nunca vão para o log** — só números e identificadores. Dois testes garantem isso.

## Testar relevância com dados reais

```bash
pnpm --filter @megabot/worker knowledge:search -- --tenant <uuid> "qual o prazo de entrega?"
```

Usa o provedor de verdade e imprime os trechos, a similaridade de cada um, os tokens e o custo. Aceita `--limite`, `--tokens`, `--min` e `--por-fonte` para experimentar limites sem mexer no `.env`.

## Testes

```bash
pnpm build                                  # os pacotes são consumidos do dist
pnpm --filter @megabot/retrieval test
```

- `tests/tokens.test.ts` — contagem e corte por tokens.
- `tests/retriever.test.ts` — o fluxo com dublês (sem banco e sem rede).
- `tests/relevancia.test.ts` — **Postgres + pgvector de verdade**: ingere um corpus de amostra, faz 15 perguntas e cobra acerto em 1º lugar e entre os 3 primeiros; também checa isolamento entre tenants. Precisa do banco de pé (`pnpm db:up`).

O teste de relevância usa um provedor de embeddings **léxico e determinístico** (`tests/lexical-embedder.ts`), não o modelo de verdade: o objetivo é medir a **nossa** mecânica (ordenação, limiar, diversidade, limites, isolamento) de forma reprodutível e sem chave de API. Semântica do modelo (sinônimo, paráfrase) se confere com o comando `knowledge:search` acima.
