# ADR 0019 — Pacote `ai` (LLM, embeddings, custo e erros)

- **Status:** Aceita (implementa o [ADR 0009](0009-provedor-de-llm.md); a escolha do provedor/modelos segue **pendente** lá)
- **Data:** 2026-11-20
- **Contexto da task:** T2.1

## Contexto

O agente (Sprint 2) precisa de um modelo para responder e de embeddings para a busca na base de conhecimento. O ADR 0009
propõe OpenAI atrás de uma interface interna e pede: timeout, retentativa, registro de uso por tenant e nenhum dado de
um tenant no contexto de outro.

## Decisões

| Tema                | Escolha                                                                                                                                                                                            | Por quê                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Interfaces          | `LLMProvider.generate` e `EmbeddingProvider.embed` (o ADR 0009 falava em `LlmProvider`: nomes finais seguem a task)                                                                                | Trocar/combinar provedores sem mexer no domínio                                                   |
| Provedor            | `OpenAiProvider` com **HTTP direto** (`fetch`), sem SDK                                                                                                                                            | Menos dependências e superfície de supply chain; fácil de testar; mesmo estilo do `whatsapp`      |
| Modelos e preços    | **Só configuração** (`AI_CHAT_MODEL`, `AI_EMBEDDING_MODEL`, `AI_PRICING_JSON`); sem padrão no código                                                                                               | O ADR 0009 não fixa modelos; preços mudam. Modelo sem preço → `costUsd = null` (nunca inventamos) |
| Tool calling tipado | Ferramenta = schema **Zod** (`defineTool`); o JSON Schema enviado ao modelo sai do Zod e os argumentos devolvidos são **validados**; `toolCalls` é uma união discriminada pelo nome (`as const`)   | Um só lugar descreve e valida; o compilador impede usar argumento da ferramenta errada            |
| Resposta inválida   | Ferramenta desconhecida/JSON ou argumentos inválidos → `invalid_response`, **sem repetir** (o consumo ainda é registrado)                                                                          | Repetir gasta tokens de novo e raramente resolve                                                  |
| Custo               | `estimateCostUsd`: entrada normal + entrada em cache + saída, USD por 1M de tokens, arredondado a 1e-9. **Estimado**: serve para acompanhar consumo/cota, não para faturar                         | O provedor pode cobrar diferente (descontos/arredondamentos)                                      |
| Registro de uso     | `onUsage(AiUsageRecord)` ao fim de **toda** chamada (ok ou erro) + log `ai.call` + métricas com `tenant_id`. Falha no gancho não derruba a chamada                                                 | Base para a cota (ADR 0011). Persistência por tenant fica para a task que usar o pacote           |
| Timeout             | Por tentativa (`AI_TIMEOUT_MS`, 30 s) via `AbortSignal`; cancelamento externo por `signal`                                                                                                         | Não segura worker; permite desligamento gracioso                                                  |
| Retentativa         | Interna e curta (`AI_MAX_RETRIES`=2): _backoff_ exponencial com _jitter_ total e `Retry-After`. Espera acima de 20 s **não** é aguardada: o erro volta com `retryAfterMs` para o **job** reagendar | Duas camadas: o pacote cobre soluços; o pg-boss cobre indisponibilidade longa                     |
| Erros               | `AiError` com `category` + `retryable`; 429 de **cota** (`insufficient_quota`) é definitivo, 429 de **taxa** é transitório                                                                         | O worker decide pelo tipo (`NonRetryableError` quando `!retryable`)                               |
| Privacidade         | Logs/métricas só com ids, contagens e códigos. Nunca texto de mensagens, respostas, embeddings, chave ou a mensagem de erro do provedor (que pode ecoar o prompt)                                  | LGPD e ADR 0009                                                                                   |

## Consequências

- **Bom:** domínio desacoplado do provedor; erros e custo previsíveis; testável sem rede.
- **Atenção:** a chave é **da plataforma** (um provedor para todos os tenants); por isso o `tenantId` é obrigatório em cada chamada. Dimensão de embedding fixa o `vector(N)`: trocar de modelo exige reindexar.
- **Pendente (ADR 0009):** confirmar OpenAI e os modelos; orçamento por tenant; _fallback_ se o provedor cair (resposta padrão/humano).
- **Próximos passos naturais:** persistir `AiUsageRecord` por tenant e ligar à cota; consumidor do `llm.reply` (agente) usando este pacote; _streaming_ e saída estruturada se necessário.
