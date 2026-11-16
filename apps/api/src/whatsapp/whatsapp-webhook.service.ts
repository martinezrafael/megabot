import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { findWhatsappConnectionByPhoneNumberId, storeWebhookEvents } from '@megabot/database';
import {
  WebhookPayloadError,
  parseWebhook,
  verifyWebhookChallenge,
  verifyWebhookSignature,
  type WebhookEvent,
  type WhatsAppMetrics,
} from '@megabot/whatsapp';
import { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../config.tokens';
import { WEBHOOK_METRIC, createLogMetrics, toWhatsAppLogger } from './log-metrics';
import { groupByPhoneNumber, toNewWebhookEvent } from './webhook-events.mapper';

/** O `challenge` da Meta é um número; aceitamos só caracteres seguros para ecoá-lo. */
const SAFE_CHALLENGE = /^[A-Za-z0-9_-]{1,256}$/;

export interface WebhookSummary {
  events: number;
  stored: number;
  duplicates: number;
  /** Eventos de números que não estão ligados a nenhum tenant (descartados). */
  unknownNumberEvents: number;
  invalidItems: number;
}

@Injectable()
export class WhatsappWebhookService {
  private readonly metrics: WhatsAppMetrics;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.metrics = createLogMetrics(logger);
  }

  /** GET de verificação: devolve o challenge se o token confere, senão null (-> 403). */
  verifyChallenge(query: Record<string, unknown>): string | null {
    const { verifyToken } = this.config.whatsapp;
    if (!verifyToken) return null;
    const text = (key: string) =>
      typeof query[key] === 'string' ? (query[key] as string) : undefined;

    const challenge = verifyWebhookChallenge(
      {
        'hub.mode': text('hub.mode'),
        'hub.verify_token': text('hub.verify_token'),
        'hub.challenge': text('hub.challenge'),
      },
      verifyToken,
    );
    return challenge !== null && SAFE_CHALLENGE.test(challenge) ? challenge : null;
  }

  /**
   * POST: confere a assinatura, interpreta, descobre o tenant de cada número e grava.
   * Só devolve quando os eventos estão no banco; qualquer processamento pesado fica para o worker.
   */
  async handle(rawBody: Buffer, signature: string | undefined): Promise<WebhookSummary> {
    const started = performance.now();
    const outcome = (name: 'ok' | 'invalid_signature' | 'invalid_payload' | 'not_configured') => {
      this.metrics.increment(WEBHOOK_METRIC.requests, { outcome: name });
      this.metrics.timing(WEBHOOK_METRIC.duration, Math.round(performance.now() - started), {
        outcome: name,
      });
    };

    const { appSecret } = this.config.whatsapp;
    if (!appSecret) {
      outcome('not_configured');
      this.logger.error(
        { event: 'whatsapp.webhook.not_configured' },
        'WHATSAPP_APP_SECRET não configurado: webhook recusado',
      );
      throw new ServiceUnavailableException('Webhook do WhatsApp não configurado.');
    }

    // 1) Autenticidade: HMAC do corpo cru com o app secret. Antes de QUALQUER outra coisa.
    if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
      outcome('invalid_signature');
      this.logger.warn(
        { event: 'whatsapp.webhook.invalid_signature', has_signature: Boolean(signature) },
        'Assinatura do webhook inválida',
      );
      throw new UnauthorizedException('Assinatura inválida.');
    }

    // 2) Interpretação. Assinatura válida mas corpo estranho = erro do remetente (400).
    let parsed;
    try {
      parsed = parseWebhook(JSON.parse(rawBody.toString('utf8')), {
        logger: toWhatsAppLogger(this.logger),
      });
    } catch (error) {
      outcome('invalid_payload');
      const reason = error instanceof WebhookPayloadError ? error.message : 'corpo não é JSON';
      this.logger.warn({ event: 'whatsapp.webhook.invalid_payload', reason }, 'Payload inválido');
      throw new BadRequestException('Payload de webhook inválido.');
    }

    // 3) Tenant por número + gravação idempotente (um grupo por número).
    const groups = groupByPhoneNumber(parsed.events);
    const results = await Promise.all(
      [...groups.entries()].map(([phoneNumberId, events]) =>
        this.storeGroup(phoneNumberId, events),
      ),
    );

    const summary: WebhookSummary = {
      events: parsed.events.length,
      stored: results.reduce((sum, r) => sum + r.inserted, 0),
      duplicates: results.reduce((sum, r) => sum + r.duplicates, 0),
      unknownNumberEvents: results.reduce((sum, r) => sum + r.unknown, 0),
      invalidItems: parsed.invalid.length,
    };

    // Com um único tenant no lote (o normal), o log "request completed" também sai com tenant_id.
    const tenants = [...new Set(results.flatMap((r) => (r.tenantId ? [r.tenantId] : [])))];
    if (tenants.length === 1) {
      try {
        this.logger.assign({ tenant_id: tenants[0] });
      } catch {
        // Fora de uma requisição: o log é secundário.
      }
    }

    outcome('ok');
    this.logger.info(
      { event: 'whatsapp.webhook.handled', ...summary, tenants: tenants.length },
      'Webhook do WhatsApp processado',
    );
    return summary;
  }

  private async storeGroup(phoneNumberId: string, events: WebhookEvent[]) {
    const connection = await findWhatsappConnectionByPhoneNumberId(phoneNumberId);

    if (!connection) {
      // Número que não é de nenhum tenant (desconectado ou ainda não cadastrado). Responder
      // erro só faria a Meta reenviar por dias; registramos e seguimos.
      this.metrics.increment(WEBHOOK_METRIC.unknownNumber, {}, events.length);
      this.logger.warn(
        {
          event: 'whatsapp.webhook.unknown_number',
          phone_number_id: phoneNumberId,
          events: events.length,
        },
        'Webhook de número sem tenant: eventos descartados',
      );
      return { tenantId: null, inserted: 0, duplicates: 0, unknown: events.length };
    }

    const { tenantId } = connection;
    const result = await storeWebhookEvents(
      tenantId,
      events.map((e) => toNewWebhookEvent(e)),
    );

    const labels = { tenant_id: tenantId };
    for (const kind of ['message', 'status', 'error'] as const) {
      const count = events.filter((e) => e.kind === kind).length;
      if (count > 0)
        this.metrics.increment(WEBHOOK_METRIC.eventsReceived, { ...labels, kind }, count);
    }
    this.metrics.increment(WEBHOOK_METRIC.eventsStored, labels, result.inserted);
    if (result.duplicates > 0) {
      this.metrics.increment(WEBHOOK_METRIC.eventsDuplicate, labels, result.duplicates);
    }
    this.logger.info(
      {
        event: 'whatsapp.webhook.stored',
        tenant_id: tenantId,
        phone_number_id: phoneNumberId,
        received: result.received,
        inserted: result.inserted,
        duplicates: result.duplicates,
      },
      'Eventos do WhatsApp gravados',
    );
    return { tenantId, inserted: result.inserted, duplicates: result.duplicates, unknown: 0 };
  }
}
