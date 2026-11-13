# ADR 0005 — pg-boss para filas e jobs

- **Status:** Aceita
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

Precisamos processar em segundo plano: mensagens recebidas do WhatsApp (webhook responde rápido e
enfileira), chamadas ao LLM, envio de mensagens, cobranças e tarefas agendadas. Os jobs precisam
de retentativas, _backoff_, idempotência e visibilidade de falhas.

## Opções consideradas

| Opção                   | Prós                                                                                         | Contras                                          |
| ----------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **pg-boss**             | Usa o Postgres que já temos (`SKIP LOCKED`); retentativas, cron, DLQ, prioridades; sem Redis | Throughput menor que Redis; carga extra no banco |
| BullMQ (Redis)          | Muito maduro e rápido; UI de filas                                                           | Exige Redis (custo, operação, persistência)      |
| Cloud queues (SQS etc.) | Gerenciado                                                                                   | Acopla ao provedor; ainda indefinido (ADR 0008)  |

## Decisão

Usar **pg-boss** para filas e agendamentos, em um processo separado (`apps/worker`), no mesmo
PostgreSQL, em schema próprio (`pgboss`). A variável `REDIS_URL` comentada no `.env.example` deixa
de fazer parte do plano.

## Justificativa

Um serviço a menos para operar e pagar; jobs e dados de negócio na mesma base facilitam consistência
(ex.: enfileirar na mesma transação). O volume previsto do MVP é bem abaixo do limite do pg-boss.

## Consequências

- **Requisitos:** Node ≥ 22.12 e PostgreSQL ≥ 13. O README ainda dizia Node ≥ 20.12; foi atualizado
  (CI e Dockerfile já usam Node 22).
- O worker precisa de permissão para criar o schema `pgboss` (migração/instalação inicial pelo pg-boss).
- Handlers devem ser **idempotentes** (entrega _at-least-once_).
- Se o throughput crescer, o ponto de revisão é migrar para BullMQ/Redis; manter os handlers atrás de uma interface fina.
- Pool de conexões do worker deve ser dimensionado junto com o da API.
