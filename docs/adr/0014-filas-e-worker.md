# ADR 0014 — Filas, retentativas, DLQ e worker

- **Status:** Aceita
- **Data:** 2026-11-16
- **Contexto da task:** T1.3 (complementa o [ADR 0005](0005-pg-boss-para-filas.md))

## Contexto

O webhook (T1.2) guarda o evento e responde 200 rápido; todo o resto (processar a mensagem, chamar o
LLM, enviar a resposta) precisa rodar fora da requisição, com novas tentativas e sem perder trabalho.

## Decisões

| Tema               | Escolha                                                                                                                                                               | Por quê                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Pacote             | `@megabot/queue` encapsula o pg-boss **12.38.2** (versão fixa): definição das filas, `enqueue`, `work`, leitura para o admin                                          | Um único lugar conhece o pg-boss; atualizar a versão é uma decisão consciente               |
| Filas iniciais     | `system.ping`, `whatsapp.inbound`, `whatsapp.outbound`, `llm.reply`                                                                                                   | As etapas do fluxo de conversa; cada uma com política própria de tentativas e tempo limite  |
| Payload            | Só IDs + `tenantId` obrigatório (Zod). Nunca texto de mensagem nem dados pessoais                                                                                     | LGPD e RLS: o conteúdo mora no banco, o job só aponta; `tenant_id` em todo log e métrica    |
| Retentativas       | Espera exponencial com sorteio (jitter), com teto, por fila (ex.: inbound 6 tentativas, 5 s → 10 min)                                                                 | Falha temporária (rede, limite da Meta) se resolve sozinha sem sobrecarregar o serviço      |
| DLQ                | Fila `<nome>.dlq` por fila; o job vai para lá ao esgotar as tentativas **ou** quando o erro é definitivo (`NonRetryableError` / `retryable: false`). Retenção 30 dias | Erro definitivo (ex.: janela de 24h fechada, ADR 0010) não deve gastar tentativas           |
| Entrega            | "Pelo menos uma vez"; handler idempotente. Enfileirar com `jobId` fixo (ex.: id do `webhook_events`) é idempotente                                                    | Padrão do pg-boss; duplicidade é tratada na ponta                                           |
| Worker             | `apps/worker`: config validada com Zod (falha rápida), logs pino, `SIGTERM`/`SIGINT` → para de pegar jobs, espera os ativos (30 s), fecha o banco, sai com 0          | Deploys não matam jobs no meio; segundo sinal força a saída                                 |
| Tela de filas      | `GET /admin/queues` e `GET /admin/queues/:nome/jobs` leem `pgboss.queue`/`pgboss.job` direto (somente leitura); tela `/admin/queues` no web                           | O pg-boss não traz painel; leitura direta cumpre o DoD sem dependência nova                 |
| Quem acessa a tela | **Administrador da plataforma**: e-mail verificado listado em `PLATFORM_ADMIN_EMAILS`. Lista vazia = ninguém                                                          | A tela mostra jobs de todas as empresas; o papel ADMIN de um tenant não pode dar esse poder |
| Métricas           | Linhas de log `event: "metric"` com `tenant_id`, atrás da interface `QueueMetrics`                                                                                    | Mesmo padrão do T1.2; troca por Prometheus/OTel quando houver coletor                       |

## Consequências

- O admin **nunca** devolve o payload dos jobs: só empresa, estado, tentativas e resumo do erro (300 caracteres).
- As consultas do admin dependem do schema de tabelas do pg-boss 12; o teste `packages/queue/tests/inspector.test.ts`
  quebra se uma atualização mudar isso.
- O pool do worker (padrão 4) soma-se ao da API: dimensione o `max_connections` do Postgres para os dois.
- `enqueue` ainda não participa da transação do negócio (o pg-boss permite via `db`); hoje o webhook grava o evento e
  enfileira em passos separados. Se o enfileiramento falhar, o evento continua `pending` em `webhook_events` e pode ser re-enfileirado.
- Filas sem handler (`whatsapp.*`, `llm.reply`) acumulam jobs até a task que as implementa registrar o handler em `apps/worker/src/handlers/index.ts`.
- A tela não tem ações (reprocessar da DLQ, cancelar): é para acompanhar. Ações exigem trilha de auditoria — decidir à parte.
- `docker-compose` não sobe o worker (ele roda com `pnpm dev`/imagem própria). O Dockerfile do worker passou para Node 22 (exigência do pg-boss 12).

## Pendente

- Valores definitivos de tentativas/tempo por fila (ajustar com dados reais).
- Alertas (DLQ com jobs, fila parada) — dependem do coletor de métricas.
