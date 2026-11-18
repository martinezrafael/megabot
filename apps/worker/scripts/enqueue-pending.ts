/**
 * Enfileira em `whatsapp.inbound` (mensagens, erros) e `whatsapp.status` (status) os eventos do webhook que ainda estão `pending` (só desenvolvimento).
 *
 * Por quê: o webhook (T1.2) grava o evento no banco, mas ainda NÃO enfileira o job. Este script faz
 * essa ponte manualmente para você ver o job da T1.5 funcionando de ponta a ponta:
 *   1. com a API rodando, mande um webhook de teste (ou use `whatsapp:connect` + túnel);
 *   2. com o worker rodando (`pnpm --filter @megabot/worker dev`), rode:
 *        pnpm --filter @megabot/worker inbound:enqueue-pending
 *
 * Rodar duas vezes é seguro: o id do job é o id do evento, então não duplica.
 */
import { listPendingWebhookEvents, prisma } from '@megabot/database';
import { QUEUES, QueueClient } from '@megabot/queue';

if (process.env.NODE_ENV === 'production') {
  console.error('inbound:enqueue-pending não roda em produção.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL ausente (confira o .env na raiz).');
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new QueueClient({ connectionString: databaseUrl as string });
  try {
    await client.start();
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    let enqueued = 0;
    let already = 0;
    for (const { id: tenantId } of tenants) {
      for (const { id: webhookEventId, kind } of await listPendingWebhookEvents(tenantId)) {
        // Status de mensagem enviada vai para a fila `whatsapp.status`; o resto, para `whatsapp.inbound`.
        const queue = kind === 'status' ? QUEUES.whatsappStatus : QUEUES.whatsappInbound;
        const result = await client.enqueue(
          queue,
          { tenantId, webhookEventId },
          { jobId: webhookEventId },
        );
        if (result.deduplicated) already += 1;
        else enqueued += 1;
      }
    }
    console.info(`enfileirados: ${enqueued} | já estavam na fila: ${already}`);
  } finally {
    await client.stop({ timeoutMs: 5_000 });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
