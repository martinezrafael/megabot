# @megabot/ai

Ligação com o **modelo de IA**: chat com _tool calling_ tipado, embeddings e **registro de tokens e custo estimado a cada chamada**. Não depende de NestJS nem do banco: quem usa (API/worker) injeta logger, métricas e o gancho de registro de uso. Segue o [ADR 0009](../../docs/adr/0009-provedor-de-llm.md) (provedor OpenAI atrás de uma interface) e o [ADR 0019](../../docs/adr/0019-pacote-ai.md).

## O que tem

| Parte                           | Para quê                                                                                     | Arquivo          |
| ------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `LLMProvider`                   | Interface do chat: `generate({ tenantId, messages, tools? })`                                | `src/types.ts`   |
| `EmbeddingProvider`             | Interface de embeddings: `embed({ tenantId, input })`                                        | `src/types.ts`   |
| `OpenAiProvider`                | Implementa as duas (HTTP direto, sem SDK), com timeout, retries, custo e observabilidade     | `src/openai.ts`  |
| `defineTool` / `parseToolCalls` | Ferramentas com schema Zod; os argumentos devolvidos pelo modelo vêm **validados e tipados** | `src/tools.ts`   |
| `AiError`                       | Erro com `category` e `retryable` (o worker decide pelo tipo, não por texto)                 | `src/errors.ts`  |
| `estimateCostUsd`, preços       | Custo estimado a partir de uma tabela de preços **de configuração**                          | `src/pricing.ts` |
| `loadAiConfig`                  | Lê e valida o ambiente (falha rápida)                                                        | `src/config.ts`  |
| `FakeLlmProvider` etc.          | Dublês para testar quem usa o pacote, sem rede nem custo                                     | `src/testing.ts` |

## Configuração (`.env`)

| Variável                  | Obrigatória | Para quê                                                                   |
| ------------------------- | ----------- | -------------------------------------------------------------------------- |
| `OPENAI_API_KEY`          | sim         | Chave da API (nunca é logada)                                              |
| `AI_CHAT_MODEL`           | sim         | Modelo de chat (sem padrão: o ADR 0009 não fixa modelos)                   |
| `AI_EMBEDDING_MODEL`      | sim         | Modelo de embedding                                                        |
| `AI_EMBEDDING_DIMENSIONS` | não         | Dimensão do vetor (deve casar com o `vector(N)` do banco)                  |
| `AI_PRICING_JSON`         | não         | Preços por modelo, USD por 1M de tokens. Sem preço, o custo vem `null`     |
| `AI_TIMEOUT_MS`           | não         | Tempo máximo **por tentativa** (padrão 30000)                              |
| `AI_MAX_RETRIES`          | não         | Repetições internas de falhas transitórias (padrão 2 → até 3 chamadas)     |
| `AI_BASE_URL`             | não         | Outra URL compatível com a API da OpenAI (padrão `https://api.openai.com`) |

```env
AI_PRICING_JSON={"nome-do-modelo-de-chat":{"inputPerMillion":0.4,"outputPerMillion":1.6,"cachedInputPerMillion":0.1}}
```

(Valores de exemplo: use os preços **atuais** da página de preços do provedor.)

## Usar

```ts
import { createOpenAiProvider, loadAiConfig, defineTool } from '@megabot/ai';
import { z } from 'zod';

const ai = createOpenAiProvider(loadAiConfig(), {
  logger, // pino já serve
  metrics, // { increment(name, labels, value), timing(name, ms, labels) }
  onUsage: async (record) => {
    /* grave o consumo por tenant (record.tenantId, tokens, costUsd) */
  },
});

const buscarProduto = defineTool({
  name: 'buscar_produto',
  description: 'Busca um produto no catálogo do tenant',
  parameters: z.object({ termo: z.string().min(2) }),
});

const result = await ai.generate({
  tenantId, // obrigatório: vai em todo log, métrica e registro de uso
  messages: [
    { role: 'system', content: 'Você atende clientes pelo WhatsApp.' },
    { role: 'user', content: 'Vocês têm camiseta preta?' },
  ],
  tools: [buscarProduto] as const, // `as const` é o que tipa as chamadas
});

for (const call of result.toolCalls) {
  if (call.name === 'buscar_produto') call.arguments.termo; // string (validado)
}
result.text; // texto (ou null se só chamou ferramentas)
result.usage; // { inputTokens, cachedInputTokens, outputTokens, totalTokens }
result.costUsd; // estimado (null se o modelo não tem preço configurado)

const { embeddings } = await ai.embed({ tenantId, input: ['texto 1', 'texto 2'] });
```

Para devolver o resultado de uma ferramenta ao modelo, acrescente ao histórico a mensagem `assistant` com `toolCalls` e uma mensagem `{ role: 'tool', toolCallId, content }` e chame `generate` de novo.

## Erros: quem repete o quê

`AiError` traz `category` e `retryable`. O pacote já repete **internamente** (`AI_MAX_RETRIES`) as falhas transitórias, com _backoff_ exponencial e _jitter_, e respeita `Retry-After`. Se o provedor pedir uma espera maior que 20 s, o erro volta com `retryAfterMs` para o **job** reagendar (não seguramos um worker parado).

| `category`         | Repete? | Significa                                                        |
| ------------------ | ------- | ---------------------------------------------------------------- |
| `rate_limit`       | sim     | Limite de taxa do provedor                                       |
| `temporary`        | sim     | 5xx, rede                                                        |
| `timeout`          | sim     | Estourou `AI_TIMEOUT_MS`                                         |
| `auth`             | não     | Chave inválida (ação humana)                                     |
| `quota`            | não     | Saldo/cota do provedor esgotados (ação humana)                   |
| `context_length`   | não     | Prompt maior que o contexto: reduzir                             |
| `content_filter`   | não     | Recusado pela política do provedor                               |
| `invalid_request`  | não     | Pedido inválido (bug nosso ou modelo inexistente)                |
| `invalid_response` | não     | Resposta fora do formato; tool desconhecida/argumentos inválidos |
| `aborted`          | não     | Cancelada por quem chamou (`signal`)                             |

No worker, trate `error.retryable === false` como `NonRetryableError` (veja `@megabot/queue`).

## Privacidade e observabilidade

- Todo log, métrica e registro de uso leva o `tenant_id`.
- **Nunca** vão para log/métrica: texto das mensagens, respostas, embeddings, a chave da API e a mensagem de erro do provedor (que pode repetir o prompt; fica só em `AiError.providerMessage`, truncada, para depuração local).
- Log `ai.call` (1 por chamada): modelo, operação, resultado, tokens, `cost_usd`, `latency_ms`, `attempts`, `request_id`. Também `ai.retry` e `ai.usage_missing`.
- Métricas (`METRIC`): `ai_requests_total`, `ai_request_duration_ms`, `ai_tokens_total` (`kind`: input/cached_input/output), `ai_cost_usd_total`, `ai_retries_total`.
- `onUsage` recebe um `AiUsageRecord` ao fim de **toda** chamada (inclusive as que falham depois de gastar tokens). Uma falha no gancho é logada e **não** derruba a resposta.

## Teste manual com o provedor real

```bash
pnpm --filter @megabot/ai smoke   # chat, tool calling e embeddings; imprime tokens e custo (nunca a chave)
```

## Testes

```bash
pnpm --filter @megabot/ai test
```

Sem rede: `fetch` falso, mais um servidor HTTP local de verdade para timeout, cancelamento e `Retry-After`. Os testes não precisam de banco nem de chave.
