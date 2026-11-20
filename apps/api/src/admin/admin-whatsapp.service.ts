import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PhoneNumberTakenError,
  TenantNotFoundError,
  connectWhatsappNumber,
  listWhatsappConnections,
  type WhatsappConnectionView,
} from '@megabot/database';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../config.tokens';
import { createLogMetrics } from '../whatsapp/log-metrics';

export interface ConnectInput {
  tenantId: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  displayPhoneNumber?: string | undefined;
}

export const CONNECTION_METRIC = {
  /** Rótulos: tenant_id, outcome (created|updated|conflict|tenant_not_found). */
  connect: 'whatsapp_connection_admin_total',
} as const;

@Injectable()
export class AdminWhatsappService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  async connect(
    input: ConnectInput,
    actorEmail: string,
  ): Promise<{ created: boolean; connection: WhatsappConnectionView }> {
    const cipher = this.config.tokenCipher;
    if (!cipher) {
      throw new ServiceUnavailableException(
        'Criptografia de tokens não configurada (defina TOKEN_ENCRYPTION_KEYS).',
      );
    }
    const metrics = createLogMetrics(this.logger);
    const { tenantId } = input;
    // Nunca logamos o token (nem o corpo da requisição): só ids e o resultado.
    const base = { tenant_id: tenantId, phone_number_id: input.phoneNumberId, actor: actorEmail };

    try {
      const result = await connectWhatsappNumber(
        tenantId,
        {
          phoneNumberId: input.phoneNumberId,
          wabaId: input.wabaId,
          accessToken: input.accessToken,
          ...(input.displayPhoneNumber ? { displayPhoneNumber: input.displayPhoneNumber } : {}),
        },
        cipher,
      );
      const outcome = result.created ? 'created' : 'updated';
      metrics.increment(CONNECTION_METRIC.connect, { tenant_id: tenantId, outcome });
      this.logger.info(
        {
          event: 'whatsapp.connection.admin',
          ...base,
          outcome,
          token_key_id: result.connection.tokenKeyId,
        },
        result.created ? 'Número do WhatsApp conectado' : 'Conexão do WhatsApp atualizada',
      );
      return result;
    } catch (error) {
      if (error instanceof PhoneNumberTakenError) {
        metrics.increment(CONNECTION_METRIC.connect, { tenant_id: tenantId, outcome: 'conflict' });
        this.logger.warn(
          { event: 'whatsapp.connection.admin', ...base, outcome: 'conflict' },
          'Número já conectado a outro tenant',
        );
        throw new ConflictException(error.message);
      }
      if (error instanceof TenantNotFoundError) {
        metrics.increment(CONNECTION_METRIC.connect, {
          tenant_id: tenantId,
          outcome: 'tenant_not_found',
        });
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  list(tenantId: string): Promise<WhatsappConnectionView[]> {
    return listWhatsappConnections(tenantId);
  }
}
