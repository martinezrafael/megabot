/**
 * Enfileira o envio de UMA mensagem de teste pelo WhatsApp (só desenvolvimento).
 *
 * Uso (com o worker rodando e WHATSAPP_API_TOKEN no .env):
 *   pnpm --filter @megabot/worker outbound:send-test <tenantId> <numeroDoContato> "Seu texto"
 *   pnpm --filter @megabot/worker outbound:send-test <tenantId> <numeroDoContato> --template hello_world en_US
 *
 * - O texto livre só funciona se o contato falou com o número nas últimas 24h (senão a janela
 *   está fechada e o comando recusa, como o sistema real).
 * - O template `hello_world` (en_US) já vem aprovado no número de teste da Meta e funciona sempre.
 * - O número do contato é só dígitos com DDI, ex.: 5511999998888. No número de teste da Meta ele
 *   precisa estar na lista de destinatários permitidos.
 */
import { WindowClosedError, prisma, upsertContact } from '@megabot/database';
import { QUEUES, QueueClient } from '@megabot/queue';
import { queueOutboundMessage } from '../src/handlers/outbound-message';

if (process.env.NODE_ENV === 'production') {
  console.error('outbound:send-test não roda em produção.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL ausente (confira o .env na raiz).');
  process.exit(1);
}

const [tenantId, waId, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
if (!tenantId || !waId || rest.length === 0) {
  console.error(
    'Uso: outbound:send-test <tenantId> <numero> "texto"  |  outbound:send-test <tenantId> <numero> --template <nome> <idioma>',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const client = new QueueClient({ connectionString: databaseUrl as string });
  try {
    await client.start();
    const contact = await upsertContact(tenantId as string, { waId: waId as string });
    const isTemplate = rest[0] === '--template';
    const input = isTemplate
      ? {
          contactId: contact.id,
          sender: 'bot' as const,
          type: 'template',
          kind: 'template' as const,
          content: { name: rest[1] ?? 'hello_world', language: rest[2] ?? 'en_US' },
        }
      : { contactId: contact.id, sender: 'bot' as const, type: 'text', body: rest.join(' ') };

    const record = await queueOutboundMessage(
      {
        enqueue: (payload, options) => client.enqueue(QUEUES.whatsappOutbound, payload, options),
      },
      tenantId as string,
      input,
    );
    console.info(`enfileirado: mensagem ${record.id} (acompanhe o worker e /admin/queues)`);
  } catch (error) {
    if (error instanceof WindowClosedError) {
      console.error(
        'Janela de 24h fechada para este contato: texto livre não é permitido. Use --template hello_world en_US.',
      );
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    await client.stop({ timeoutMs: 5_000 });
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
