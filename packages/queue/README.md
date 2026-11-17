# @megabot/queue

Filas de tarefas do MegaBot sobre o **pg-boss** (Postgres, schema `pgboss`): define as filas, enfileira, executa com novas tentativas, manda falhas para a **DLQ** e lê o estado para a tela de admin. Decisões: [ADR 0005](../../docs/adr/0005-pg-boss-para-filas.md) e [ADR 0014](../../docs/adr/0014-filas-e-worker.md).

> Requer Node ≥ 22.12 (o pg-boss 12 é ESM e o pacote o carrega via `require`).

## Filas (`src/definitions.ts`)

| Fila                | Para quê                       | Tentativas extras | Espera (inicial → teto) |
| ------------------- | ------------------------------ | ----------------- | ----------------------- |
| `system.ping`       | Teste de fumaça do pipeline    | 2                 | 2 s → 30 s              |
| `whatsapp.inbound`  | Processar evento do webhook    | 6                 | 5 s → 10 min            |
| `whatsapp.outbound` | Enviar mensagem pela Cloud API | 8                 | 5 s → 15 min            |
| `llm.reply`         | Gerar resposta com o LLM       | 4                 | 10 s → 5 min            |

Cada fila tem a DLQ `<nome>.dlq` (retenção de 30 dias). Todo payload exige `tenantId` e carrega só IDs.

## Enfileirar

```ts
import { QueueClient, QUEUES, createLogMetrics } from '@megabot/queue';

const queue = new QueueClient({
  connectionString: process.env.DATABASE_URL!,
  logger,
  metrics: createLogMetrics(logger),
});
await queue.start(); // instala o schema do pg-boss e cria/ajusta as filas

// jobId fixo = idempotente: enfileirar 2x cria 1 job só (ex.: id do webhook_events)
const { jobId, deduplicated } = await queue.enqueue(
  QUEUES.whatsappInbound,
  { tenantId, webhookEventId },
  { jobId: webhookEventId },
);
```

## Executar (no worker)

```ts
import { NonRetryableError } from '@megabot/queue';

await queue.work(
  QUEUES.whatsappOutbound,
  async ({ payload, attempt, maxAttempts, signal, logger }) => {
    // logger já traz tenant_id, queue e job_id
    // retornar = sucesso; lançar erro = falha
    // erro com `retryable: false` (ex.: WhatsAppApiError de janela expirada) ou NonRetryableError => DLQ direto
    // qualquer outro erro => repete com espera crescente; esgotou => DLQ
  },
);
```

`signal` é cancelado quando o job expira ou o processo desliga. `queue.stop({ timeoutMs })` espera os jobs ativos.

## Ler o estado (admin)

`QueueInspector` consulta `pgboss.queue` e `pgboss.job` (somente leitura): `overview()` (contagem por estado, espera mais antiga), `listJobs({ queue, state, tenantId, limit })`. **Nunca devolve o payload.**

## Logs e métricas

- `queue.enqueued`, `queue.job` (`outcome`: `completed` | `retry` | `dead_letter`), `queue.started/stopped/error`, todos com `tenant_id` (menos erros do próprio pg-boss).
- Métricas: `queue_jobs_enqueued_total`, `queue_jobs_processed_total{queue,tenant_id,outcome}`, `queue_job_duration_ms`.

## Testes

```bash
pnpm --filter @megabot/queue test   # precisa do Postgres (pnpm db:up); usa schemas temporários pgboss_test_*
```
