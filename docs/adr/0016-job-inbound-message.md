# ADR 0016 — Job `inbound-message` e decisão de acionar o agente

- **Status:** Aceita (limites e planos seguem pendentes de negócio)
- **Data:** 2026-11-18
- **Contexto da task:** T1.5 (usa o [ADR 0015](0015-modelo-de-conversas.md); aplica a cota do [ADR 0011](0011-regra-de-cota.md))

## Contexto

O webhook (T1.2) guarda cada evento da Meta em `webhook_events` e a fila (T1.3) entrega jobs ao worker.
Falta o job que transforma o evento em contato, conversa e mensagem e decide se o agente (LLM) responde.

## Decisões

| Tema                  | Escolha                                                                                                                                                                              | Por quê                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Onde roda             | Fila `whatsapp.inbound`; payload `{ tenantId, webhookEventId }`. O conteúdo é lido do banco (RLS), nunca do payload do job                                                           | ADR 0005: jobs só com ids                                                           |
| Eventos tratados      | `message` (fluxo completo), `status` (atualiza a mensagem enviada), `error` (só log). Como a fila é uma só, status e erro também precisam de handler                                 | Sem isso, status iriam para a DLQ                                                   |
| Idempotência          | (1) `wamid` único; (2) `llm.reply` enfileirado com id calculado do evento; (3) evento só vira `processed` no **fim**; `processed` é ignorado                                         | Queda no meio ou reentrega nunca duplica mensagem, janela nem resposta              |
| Regra de decisão      | Função pura `decideAgentTrigger`, motivos em ordem: `tenant_inactive` > `window_expired` > `unsupported_type` > `quota_exceeded` > `ok`                                              | Testável sem banco e o motivo vai para log e métrica                                |
| Tenant ativo          | Colunas novas em `tenants`: `status` (`active` \| `suspended`, padrão `active`)                                                                                                      | Os estados de assinatura (ADR 0007) ainda não existem; o billing preencherá isto    |
| Cota                  | `tenants.conversation_limit_per_month` (`NULL` = sem limite). A conversa é atendida se sua **posição no mês** (ordem por início da janela e id, fuso `America/Sao_Paulo`) é ≤ limite | Sem contador nem trava: posição é estável, recalculável (ADR 0011, regra 10)        |
| Cota: conversa aberta | Conversas já abertas continuam sendo atendidas após o limite; só as **novas** são bloqueadas                                                                                         | ADR 0011, regra 5                                                                   |
| Tipos que acionam     | `text`, `interactive`, `button`. Imagem, áudio, reação etc. são gravados mas **não** acionam                                                                                         | O agente ainda não os entende (pendente de produto)                                 |
| Mensagem atrasada     | Janela já vencida: grava, não aciona (`window_expired`)                                                                                                                              | O bot não poderia responder com texto livre (ADR 0010)                              |
| Status órfão          | `not_found` repete (retry da fila) por até 10 min; depois é descartado como processado                                                                                               | Mensagem enviada pelo app do celular nunca terá wamid nosso: não deve entupir a DLQ |
| Payload inválido      | `NonRetryableError` (vai direto à DLQ) e evento `failed`. Só nomes de campos no erro, nunca valores                                                                                  | Sem dado pessoal em log/DLQ                                                         |
| Observabilidade       | `inbound_events_total{tenant_id,kind,outcome}` e `inbound_agent_decisions_total{tenant_id,trigger,reason}`; log `inbound.decision` com `tenant_id`, sem texto, nome ou número        | Mesmo padrão das tasks anteriores                                                   |

## Consequências

- Migration `20261118120000_tenant_status_quota` (reversível): colunas em `tenants` e índice `(tenant_id, window_started_at)` em `conversations`.
- `llm.reply` passa a ser enfileirado, mas **nenhum worker o consome ainda** (próxima task): os jobs acumulam na fila.
- **O webhook ainda não enfileira `whatsapp.inbound`.** Para testar localmente use `pnpm --filter @megabot/worker inbound:enqueue-pending`. Ligar o webhook (ou um relé periódico de eventos `pending`) é a próxima ponta solta.
- A cota por posição pode deslocar conversas posteriores se uma mensagem muito atrasada abrir uma conversa "no passado" do mesmo mês. Raro; aceito.
- Se o job esgotar as tentativas, o evento fica `pending` (a DLQ guarda o job; o script acima o reenfileira).

## Decisões pendentes

- Limites por plano e mensagem ao cliente quando a cota acaba (ADR 0011): **negócio/produto**.
- O agente deve responder a áudio, imagem e reações? Transferência para humano e "modo humano" por conversa (ADR 0010): **produto**.
- Estados de assinatura (`trial`, `inadimplente`...) mapeados para `tenants.status`: com o ADR 0007.
