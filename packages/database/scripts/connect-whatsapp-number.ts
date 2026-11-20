/**
 * Liga um número do WhatsApp a um tenant pela linha de comando (alternativa à rota de admin
 * `POST /admin/whatsapp/connections`, T1.7).
 *
 * Token: passe-o pela VARIÁVEL DE AMBIENTE `WHATSAPP_CONNECT_TOKEN` (nunca como argumento: ficaria no
 * histórico do shell). Com TOKEN_ENCRYPTION_KEYS definida, ele é guardado CIFRADO. Sem
 * `WHATSAPP_CONNECT_TOKEN`, liga o número sem token (usa o token global do worker).
 *
 * Uso (na raiz do repositório):
 *   WHATSAPP_CONNECT_TOKEN=EAAG... pnpm db:whatsapp-connect --tenant <uuid> --phone-number-id <id> --waba-id <id> [--display <numero>]
 *
 * Onde achar:
 *   - tenant: faça login e abra GET /me (campo tenant.id)
 *   - phone-number-id e waba-id: Meta for Developers > WhatsApp > Configuração da API
 */
import { parseArgs } from 'node:util';
import {
  PhoneNumberTakenError,
  TenantNotFoundError,
  connectWhatsappNumber,
  createTokenCipherFromEnv,
  prisma,
  registerWhatsappConnection,
} from '../src';

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

  const base = {
    phoneNumberId,
    wabaId,
    ...(values.display ? { displayPhoneNumber: values.display } : {}),
  };
  const accessToken = process.env.WHATSAPP_CONNECT_TOKEN;

  if (accessToken) {
    const cipher = createTokenCipherFromEnv();
    if (!cipher) {
      console.error('Defina TOKEN_ENCRYPTION_KEYS no .env para guardar o token cifrado.');
      process.exit(1);
    }
    try {
      const { connection, created } = await connectWhatsappNumber(
        tenantId,
        { ...base, accessToken },
        cipher,
      );
      console.info(
        `Número ${connection.phoneNumberId} ${created ? 'ligado' : 'atualizado'} no tenant ${connection.tenantId} (token cifrado com a chave "${connection.tokenKeyId}").`,
      );
    } catch (error) {
      if (error instanceof PhoneNumberTakenError || error instanceof TenantNotFoundError) {
        console.error(error.message);
        process.exit(1);
      }
      throw error;
    }
    return;
  }

  const connection = await registerWhatsappConnection(tenantId, base);
  console.info(
    `Número ${connection.phoneNumberId} ligado ao tenant ${connection.tenantId} (SEM token próprio).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
