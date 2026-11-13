# ADR 0009 — Provedor de LLM

- **Status:** Proposta
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

O bot responde clientes pelo WhatsApp usando a base de conhecimento do tenant (RAG com pgvector).
Precisamos de um modelo com boa qualidade em português, latência baixa, custo previsível,
_tool/function calling_ e saída estruturada. O `.env.example` já assume `OPENAI_API_KEY`.

## Opções consideradas

| Opção                      | Prós                                                          | Contras                                                   |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| **OpenAI**                 | Já previsto no projeto; embeddings e chat no mesmo fornecedor | Dependência de um fornecedor; dados saem do Brasil        |
| Anthropic (Claude)         | Forte em seguir instruções e em português                     | Embeddings próprios não oferecidos (exige outro provedor) |
| Google (Gemini)            | Custo competitivo, contexto longo                             | Mais uma integração                                       |
| Modelo próprio/open source | Controle de dados                                             | Operação de GPU; custo e qualidade difíceis no MVP        |

## Decisão (proposta)

Começar com **OpenAI** (chat + embeddings), acessado por uma interface interna `LlmProvider`
(`generate`, `embed`) para permitir trocar ou combinar provedores sem alterar o domínio.
Modelos e preços **não** são fixados neste ADR (mudam com frequência): ficam em configuração.

## Justificativa

Menor atrito imediato (chave já prevista, um fornecedor para chat e embeddings). A interface mantém
a opção de migrar se qualidade, custo ou política de dados pedirem.

## Consequências

- Dimensão dos embeddings define o tipo `vector(N)` no banco: trocar de modelo de embedding exige reindexar.
- Chamadas ao LLM rodam em jobs (pg-boss) com timeout, retentativa e limite de concorrência.
- Registrar uso (tokens) por tenant, base para custo e para a cota (ADR 0011).
- LGPD: informar nos termos que o conteúdo das conversas é processado por terceiro; avaliar acordo de processamento de dados.
- Prompts: nunca incluir dados de outros tenants no contexto (reforçado pelo RLS).

## Decisões pendentes

- Confirmar OpenAI (ou outro) e **modelos** de chat e embedding — **responsável: time técnico**.
- Orçamento mensal por tenant/plano.
- Plano de _fallback_ se o provedor ficar indisponível (resposta padrão ou transferência para humano).
