# ADR 0017 — Envio de mensagens, rate limit e status

- **Status:** Aceita (credenciais por tenant resolvidas na [ADR 0018](0018-token-por-numero-envelope.md))
- **Data:** 2026-11-19
- **Contexto da task:** T1.6 (usa o [ADR 0010](0010-janela-de-conversa-24h.md), o [ADR 0012](0012-pacote-whatsapp.md) e o [ADR 0015](0015-modelo-de-conversas.md))

## Contexto

As respostas precisam sair pela Cloud API sem estourar o limite de vazão da Meta, sem violar a janela de 24h
e com o status (enviada, entregue, lida, falhou) refletido na mensagem.

## Decisões

| Tema              | Escolha                                                                                                                                                                                                                                                          | Por quê                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Fluxo             | Quem quer enviar chama `queueOutboundMessage`: cria `messages` (`queued`) e enfileira `whatsapp.outbound` com `jobId` = id da mensagem. O job só carrega ids                                                                                                     | ADR 0005: jobs só com ids; enfileirar duas vezes não duplica                    |
| Janela de 24h     | Conferida **duas vezes**: ao pedir (resposta rápida, `WindowClosedError`) e **na hora do envio** (a janela pode fechar enquanto o job espera). Fora da janela: mensagem `failed` (`window_expired`), job vai à DLQ; `template` passa sempre                      | ADR 0010, decisões 5 e 6                                                        |
| Rate limit        | Balde de fichas **por número** no Postgres (`whatsapp_rate_limits`, atômico, com RLS), valendo para todos os workers. Padrão 80 msg/s (limite inicial da Meta), rajada = 1 s. Sem ficha, o job espera até 5 s; se não houver vaga, volta à fila (erro repetível) | Mais de um worker pode enviar pelo mesmo número; estado em memória não serviria |
| Falha definitiva  | Erro da Meta com `retryable: false` (destinatário inválido, token inválido, template, pedido malformado...), conteúdo inválido ou tenant sem número: mensagem `failed` com `error_code` e job direto para a DLQ                                                  | Repetir não adianta                                                             |
| Falha transitória | Rede, 5xx, limite da Meta (130429): a mensagem continua `queued` e o job repete com espera crescente (8 repetições, até 15 min). Na **última** tentativa a mensagem vira `failed`                                                                                | Nunca deixar uma mensagem eternamente `queued`                                  |
| Duplicidade       | A Meta não tem chave de idempotência. Job repetido depois de gravar o wamid é ignorado; mas se o processo cair depois de a Meta aceitar e antes de gravarmos o wamid, o retry reenvia (rara). **Aceito**                                                         | ADR 0005: entrega "pelo menos uma vez"                                          |
| Status            | Nova fila `whatsapp.status` (payload `{tenantId, webhookEventId}`) com o job `message-status`. Só avança (`sent → delivered → read`; `failed` só antes de entregue); wamid desconhecido repete por 10 min e depois é descartado                                  | O mesmo código roda dentro de `whatsapp.inbound` se um status chegar por lá     |
| Credenciais       | **Temporário:** um `WHATSAPP_API_TOKEN` global no worker (já existia no `.env.example`). Sem ele o worker não registra `whatsapp.outbound` (jobs esperam na fila, não vão para a DLQ)                                                                            | Simples para o MVP. **Contraria o ADR 0012** (token por tenant): ver pendências |
| Número de envio   | Um número por tenant (o mais antigo de `whatsapp_connections`)                                                                                                                                                                                                   | A mensagem ainda não guarda por qual número a conversa chegou                   |
| Observabilidade   | `outbound_messages_total{tenant_id,outcome}`, `outbound_rate_limited_total{tenant_id,result}`, `conversation_outbound_blocked_total`; logs `outbound.sent/retry/failed/blocked` com `tenant_id`; sem texto, número, wamid completo ou token                      | Mesmo padrão das tasks anteriores                                               |

## Consequências

- Migration `20261119120000_whatsapp_rate_limit` (reversível): tabela `whatsapp_rate_limits` com RLS.
- O webhook ainda **não enfileira** `whatsapp.inbound` nem `whatsapp.status`; `inbound:enqueue-pending` (dev) roteia cada evento pela fila certa.
- Nada chama `queueOutboundMessage` ainda em produção: será o agente (`llm.reply`) e, depois, o atendente humano.
- Se `queueOutboundMessage` cair entre criar a mensagem e enfileirar, sobra uma mensagem `queued` sem job (a chamada falha, quem pediu tenta de novo e gera outra). Uma varredura de mensagens `queued` antigas é uma melhoria futura.
- Linhas de `whatsapp_rate_limits` são uma por número (não crescem); nada a limpar.

## Decisões pendentes

- **Token por tenant** (criptografado em repouso, com rotação): precisa do ADR de segredos/KMS; troca o `WHATSAPP_API_TOKEN` global.
- Limite de vazão real de cada número (a Meta sobe o limite com o tempo): hoje é uma variável global (`WHATSAPP_RATE_LIMIT_PER_SECOND`).
- Limite de pares (a Meta aceita ~1 mensagem a cada 6 s para o mesmo cliente): não tratado.
- Mensagens enviadas pelo app do celular da empresa (eco): ignoradas.
