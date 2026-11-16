/**
 * Liga um número do WhatsApp a um tenant (até existir a tela de conexão).
 *
 * Uso (na raiz do repositório):
 *   pnpm db:whatsapp-connect --tenant <uuid> --phone-number-id <id> --waba-id <id> [--display <numero>]
 *
 * Onde achar:
 *   - tenant: faça login e abra GET /me (campo tenant.id)
 *   - phone-number-id e waba-id: Meta for Developers > WhatsApp > Configuração da API
 */
import { parseArgs } from 'node:util';
import { prisma, registerWhatsappConnection } from '../src';

async function main() {
  const { values } = parseArgs({
    options: {
      tenant: { type: 'string' },
      'phone-number-id': { type: 'string' },
      'waba-id': { type: 'string' },
      display: { type: 'string' },
    },
  });

  const tenantId = values.tenant;
  const phoneNumberId = values['phone-number-id'];
  const wabaId = values['waba-id'];
  if (!tenantId || !phoneNumberId || !wabaId) {
    console.error(
      'Uso: pnpm db:whatsapp-connect --tenant <uuid> --phone-number-id <id> --waba-id <id> [--display <numero>]',
    );
    process.exit(1);
  }

  const connection = await registerWhatsappConnection(tenantId, {
    phoneNumberId,
    wabaId,
    ...(values.display ? { displayPhoneNumber: values.display } : {}),
  });
  console.info(`Número ${connection.phoneNumberId} ligado ao tenant ${connection.tenantId}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
