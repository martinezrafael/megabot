/**
 * Teste de fumaça manual (só desenvolvimento): enfileira 3 jobs `system.ping` para você VER o
 * pipeline funcionando na tela de filas do admin e nos logs do worker:
 *   1. um que dá certo;
 *   2. um que falha de forma temporária (repete com espera crescente e acaba na DLQ);
 *   3. um que falha de forma definitiva (vai direto para a DLQ).
 *
 * Uso (com o worker rodando em outro terminal, `pnpm --filter @megabot/worker dev`):
 *   pnpm --filter @megabot/worker queue:smoke [tenantId]
 */
import { QUEUES, QueueClient } from '@megabot/queue';

if (process.env.NODE_ENV === 'production') {
  console.error('queue:smoke não roda em produção.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL ausente (confira o .env na raiz).');
  process.exit(1);
}

// Sem tenantId informado, usa um UUID fixo de demonstração (o ping não consulta o banco de negócio).
const tenantId = process.argv[2] ?? '00000000-0000-4000-8000-000000000001';
async function main(): Promise<void> {
  const client = new QueueClient({ connectionString: databaseUrl as string });
  try {
    await client.start();
    for (const simulate of ['ok', 'retryable-failure', 'fatal-failure'] as const) {
      const { jobId } = await client.enqueue(QUEUES.systemPing, { tenantId, simulate });
      console.info(`enfileirado ${simulate.padEnd(18)} job ${jobId}`);
    }
    console.info('\nAgora veja os logs do worker e a tela /admin/queues.');
  } finally {
    await client.stop({ timeoutMs: 5_000 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
