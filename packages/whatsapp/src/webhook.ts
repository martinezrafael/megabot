import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WebhookPayloadError, mapWebhookError, type WebhookErrorInfo } from './errors';
import {
  METRIC,
  noopLogger,
  noopMetrics,
  type WhatsAppLogger,
  type WhatsAppMetrics,
} from './observability';

// ===================================================================== segurança

/**
 * Valida o cabeçalho `X-Hub-Signature-256` (`sha256=<hex>`): HMAC-SHA256 do corpo BRUTO com o
 * "app secret" do app da Meta. Use o corpo exatamente como chegou (antes de `JSON.parse`).
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader.trim());
  if (!match) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1]!, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * Handshake de cadastro do webhook (GET). Se o token confere, devolva o `challenge` como texto
 * puro com status 200; se retornar `null`, responda 403.
 */
export function verifyWebhookChallenge(
  query: { 'hub.mode'?: string; 'hub.verify_token'?: string; 'hub.challenge'?: string },
  verifyToken: string,
): string | null {
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (query['hub.mode'] !== 'subscribe' || !token || !challenge || !verifyToken) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  return a.length === b.length && timingSafeEqual(a, b) ? challenge : null;
}

// ===================================================================== tipos de saída

export interface WebhookOrigin {
  /** Id da conta WhatsApp Business (`entry.id`). */
  wabaId: string;
  /** Número da empresa que recebeu/enviou. É a chave para descobrir o tenant. */
  phoneNumberId: string;
  displayPhoneNumber: string | undefined;
}

export interface MediaPayload {
  id: string;
  mimeType: string | undefined;
  sha256: string | undefined;
  caption?: string;
  filename?: string;
  /** Áudio gravado na hora (nota de voz). */
  voice?: boolean;
  /** Figurinha animada. */
  animated?: boolean;
}

export type InboundMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'button'
  | 'interactive'
  | 'reaction'
  | 'unsupported'
  /** Tipo que este pacote ainda não conhece (order, system, ...). O `raw` tem o conteúdo. */
  | 'unknown';

export interface InboundMessage extends WebhookOrigin {
  kind: 'message';
  /** `wamid...`: use para deduplicar reentregas (ADR 0010, regra 7). */
  id: string;
  type: InboundMessageType;
  /** Tipo original enviado pela Meta (útil quando `type` é `unknown`). */
  rawType: string;
  /** Telefone do cliente (`wa_id`), só dígitos. */
  from: string;
  profileName: string | undefined;
  /** Quando o CLIENTE enviou. É esta hora que abre/renova a janela de 24h (ADR 0010). */
  timestamp: Date;
  text?: string;
  media?: MediaPayload;
  location?: { latitude: number; longitude: number; name?: string; address?: string };
  contacts?: { name: string | undefined; phones: string[] }[];
  /** Clique em botão de template (resposta rápida). */
  button?: { text: string | undefined; payload: string | undefined };
  /** Resposta a botão/lista/flow. */
  interactive?: {
    type: 'button_reply' | 'list_reply' | 'nfm_reply' | 'unknown';
    id?: string;
    title?: string;
    description?: string;
    responseJson?: string;
  };
  reaction?: { messageId: string; emoji: string | undefined };
  /** Mensagem à qual esta responde/cita. */
  context?: { messageId: string | undefined; from: string | undefined; forwarded: boolean };
  /** Origem de anúncio "clique para o WhatsApp". */
  referral?: {
    sourceUrl?: string;
    sourceId?: string;
    sourceType?: string;
    headline?: string;
    body?: string;
    ctwaClid?: string;
  };
  /** Erros do tipo `unsupported` e afins. */
  errors?: WebhookErrorInfo[];
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface StatusUpdate extends WebhookOrigin {
  kind: 'status';
  /** Id da mensagem que enviamos (o `messageId` devolvido por `sendText` etc.). */
  messageId: string;
  status: DeliveryStatus;
  timestamp: Date;
  recipientId: string;
  conversation?: { id: string; originType: string | undefined; expiresAt: Date | undefined };
  pricing?: {
    billable: boolean | undefined;
    model: string | undefined;
    category: string | undefined;
  };
  /** Só em `failed`. */
  errors?: WebhookErrorInfo[];
}

/** Erro de sistema/conta enviado pela Meta (`value.errors`). */
export interface SystemError extends WebhookOrigin {
  kind: 'error';
  errors: WebhookErrorInfo[];
}

export type WebhookEvent = InboundMessage | StatusUpdate | SystemError;

export interface InvalidItem {
  reason: string;
  /** Caminho no payload, ex.: `entry[0].changes[0].value.messages[1]`. */
  path: string;
}

export interface ParsedWebhook {
  events: WebhookEvent[];
  /** Itens malformados: um item ruim não derruba o lote inteiro. */
  invalid: InvalidItem[];
  /** Quantidade de `changes` de outros campos (grupos, templates...) que ainda não tratamos. */
  ignored: number;
}

export interface ParseWebhookOptions {
  /** Se a API já resolveu o tenant (pelo `phoneNumberId`), informe para rastrear nos logs. */
  tenantId?: string;
  logger?: WhatsAppLogger;
  metrics?: WhatsAppMetrics;
}

// ===================================================================== schemas (entrada)

const envelopeSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.looseObject({
      id: z.string(),
      changes: z.array(z.looseObject({ field: z.string(), value: z.unknown() })),
    }),
  ),
});

const valueSchema = z.looseObject({
  metadata: z.looseObject({
    phone_number_id: z.string(),
    display_phone_number: z.string().optional(),
  }),
  contacts: z
    .array(
      z.looseObject({
        wa_id: z.string().optional(),
        profile: z.looseObject({ name: z.string().optional() }).optional(),
      }),
    )
    .optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
  errors: z.array(z.unknown()).optional(),
});

const timestampSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const seconds = Number(v);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    ctx.addIssue({ code: 'custom', message: 'timestamp inválido' });
    return z.NEVER;
  }
  return new Date(seconds * 1000);
});

const mediaSchema = z.looseObject({
  id: z.string(),
  mime_type: z.string().optional(),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
  animated: z.boolean().optional(),
});

const messageBaseSchema = z.looseObject({
  id: z.string(),
  from: z.string(),
  timestamp: timestampSchema,
  type: z.string(),
  context: z
    .looseObject({
      id: z.string().optional(),
      from: z.string().optional(),
      forwarded: z.boolean().optional(),
      frequently_forwarded: z.boolean().optional(),
    })
    .optional(),
  referral: z
    .looseObject({
      source_url: z.string().optional(),
      source_id: z.string().optional(),
      source_type: z.string().optional(),
      headline: z.string().optional(),
      body: z.string().optional(),
      ctwa_clid: z.string().optional(),
    })
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

const statusSchema = z.looseObject({
  id: z.string(),
  status: z.enum(['sent', 'delivered', 'read', 'failed']),
  timestamp: timestampSchema,
  recipient_id: z.string(),
  conversation: z
    .looseObject({
      id: z.string(),
      expiration_timestamp: z.union([z.string(), z.number()]).optional(),
      origin: z.looseObject({ type: z.string().optional() }).optional(),
    })
    .optional(),
  pricing: z
    .looseObject({
      billable: z.boolean().optional(),
      pricing_model: z.string().optional(),
      category: z.string().optional(),
    })
    .optional(),
  errors: z.array(z.unknown()).optional(),
});

const KNOWN_TYPES = new Set<InboundMessageType>([
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'button',
  'interactive',
  'reaction',
  'unsupported',
]);

// ===================================================================== parser

/**
 * Converte o JSON do webhook da Meta em eventos simples e tipados.
 *
 * - Envelope inválido (não é da Meta/formato quebrado) -> lança `WebhookPayloadError`.
 * - Item individual inválido -> vai para `invalid` e o resto do lote continua.
 * - Campos que ainda não tratamos (grupos, status de template...) -> contados em `ignored`.
 */
export function parseWebhook(payload: unknown, options: ParseWebhookOptions = {}): ParsedWebhook {
  const logger = options.logger ?? noopLogger;
  const metrics = options.metrics ?? noopMetrics;

  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    throw new WebhookPayloadError(`Payload de webhook inválido: ${formatIssue(envelope.error)}`);
  }

  const events: WebhookEvent[] = [];
  const invalid: InvalidItem[] = [];
  let ignored = 0;

  envelope.data.entry.forEach((entry, e) => {
    entry.changes.forEach((change, c) => {
      const path = `entry[${e}].changes[${c}]`;
      if (change.field !== 'messages') {
        ignored += 1;
        return;
      }
      const value = valueSchema.safeParse(change.value);
      if (!value.success) {
        invalid.push({ path: `${path}.value`, reason: formatIssue(value.error) });
        return;
      }
      const origin: WebhookOrigin = {
        wabaId: entry.id,
        phoneNumberId: value.data.metadata.phone_number_id,
        displayPhoneNumber: value.data.metadata.display_phone_number,
      };

      value.data.messages?.forEach((raw, i) => {
        const result = parseMessage(raw, origin, value.data.contacts);
        if (result.ok) events.push(result.event);
        else invalid.push({ path: `${path}.value.messages[${i}]`, reason: result.reason });
      });
      value.data.statuses?.forEach((raw, i) => {
        const result = parseStatus(raw, origin);
        if (result.ok) events.push(result.event);
        else invalid.push({ path: `${path}.value.statuses[${i}]`, reason: result.reason });
      });
      if (value.data.errors?.length) {
        events.push({ kind: 'error', ...origin, errors: value.data.errors.map(mapWebhookError) });
      }
    });
  });

  observe({ events, invalid, ignored }, options, logger, metrics);
  return { events, invalid, ignored };
}

type Result<T> = { ok: true; event: T } | { ok: false; reason: string };

function parseMessage(
  raw: unknown,
  origin: WebhookOrigin,
  contacts:
    | { wa_id?: string | undefined; profile?: { name?: string | undefined } | undefined }[]
    | undefined,
): Result<InboundMessage> {
  const base = messageBaseSchema.safeParse(raw);
  if (!base.success) return { ok: false, reason: formatIssue(base.error) };
  const m = base.data;
  const body = m as Record<string, unknown>;

  const rawType = m.type;
  const type: InboundMessageType = KNOWN_TYPES.has(rawType as InboundMessageType)
    ? (rawType as InboundMessageType)
    : 'unknown';
  const profile = (contacts?.find((c) => c.wa_id === m.from) ?? contacts?.[0])?.profile?.name;

  const event: InboundMessage = {
    kind: 'message',
    ...origin,
    id: m.id,
    type,
    rawType,
    from: m.from,
    profileName: profile,
    timestamp: m.timestamp,
  };
  if (m.context) {
    event.context = {
      messageId: m.context.id,
      from: m.context.from,
      forwarded: Boolean(m.context.forwarded || m.context.frequently_forwarded),
    };
  }
  if (m.referral) {
    event.referral = {
      sourceUrl: m.referral.source_url,
      sourceId: m.referral.source_id,
      sourceType: m.referral.source_type,
      headline: m.referral.headline,
      body: m.referral.body,
      ctwaClid: m.referral.ctwa_clid,
    };
  }
  if (m.errors?.length) event.errors = m.errors.map(mapWebhookError);

  switch (type) {
    case 'text': {
      const parsed = z.looseObject({ body: z.string() }).safeParse(body.text);
      if (!parsed.success) return { ok: false, reason: 'text.body ausente' };
      event.text = parsed.data.body;
      break;
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const parsed = mediaSchema.safeParse(body[type]);
      if (!parsed.success) return { ok: false, reason: `${type}.id ausente` };
      const media: MediaPayload = {
        id: parsed.data.id,
        mimeType: parsed.data.mime_type,
        sha256: parsed.data.sha256,
      };
      if (parsed.data.caption !== undefined) {
        media.caption = parsed.data.caption;
        event.text = parsed.data.caption; // legenda também vira "texto" para o bot
      }
      if (parsed.data.filename !== undefined) media.filename = parsed.data.filename;
      if (parsed.data.voice !== undefined) media.voice = parsed.data.voice;
      if (parsed.data.animated !== undefined) media.animated = parsed.data.animated;
      event.media = media;
      break;
    }
    case 'location': {
      const parsed = z
        .looseObject({
          latitude: z.number(),
          longitude: z.number(),
          name: z.string().optional(),
          address: z.string().optional(),
        })
        .safeParse(body.location);
      if (!parsed.success) return { ok: false, reason: 'location inválida' };
      event.location = {
        latitude: parsed.data.latitude,
        longitude: parsed.data.longitude,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.address !== undefined ? { address: parsed.data.address } : {}),
      };
      break;
    }
    case 'contacts': {
      const parsed = z
        .array(
          z.looseObject({
            name: z.looseObject({ formatted_name: z.string().optional() }).optional(),
            phones: z.array(z.looseObject({ phone: z.string().optional() })).optional(),
          }),
        )
        .safeParse(body.contacts);
      if (!parsed.success) return { ok: false, reason: 'contacts inválido' };
      event.contacts = parsed.data.map((c) => ({
        name: c.name?.formatted_name,
        phones: (c.phones ?? []).flatMap((p) => (p.phone ? [p.phone] : [])),
      }));
      break;
    }
    case 'button': {
      const parsed = z
        .looseObject({ text: z.string().optional(), payload: z.string().optional() })
        .safeParse(body.button);
      if (!parsed.success) return { ok: false, reason: 'button inválido' };
      event.button = { text: parsed.data.text, payload: parsed.data.payload };
      event.text = parsed.data.text;
      break;
    }
    case 'interactive': {
      const parsed = z
        .looseObject({
          type: z.string(),
          button_reply: z.looseObject({ id: z.string(), title: z.string() }).optional(),
          list_reply: z
            .looseObject({ id: z.string(), title: z.string(), description: z.string().optional() })
            .optional(),
          nfm_reply: z.looseObject({ response_json: z.string().optional() }).optional(),
        })
        .safeParse(body.interactive);
      if (!parsed.success) return { ok: false, reason: 'interactive inválido' };
      const i = parsed.data;
      if (i.type === 'button_reply' && i.button_reply) {
        event.interactive = {
          type: 'button_reply',
          id: i.button_reply.id,
          title: i.button_reply.title,
        };
        event.text = i.button_reply.title;
      } else if (i.type === 'list_reply' && i.list_reply) {
        event.interactive = {
          type: 'list_reply',
          id: i.list_reply.id,
          title: i.list_reply.title,
          ...(i.list_reply.description !== undefined
            ? { description: i.list_reply.description }
            : {}),
        };
        event.text = i.list_reply.title;
      } else if (i.type === 'nfm_reply' && i.nfm_reply) {
        event.interactive = {
          type: 'nfm_reply',
          ...(i.nfm_reply.response_json !== undefined
            ? { responseJson: i.nfm_reply.response_json }
            : {}),
        };
      } else {
        event.interactive = { type: 'unknown' };
      }
      break;
    }
    case 'reaction': {
      const parsed = z
        .looseObject({ message_id: z.string(), emoji: z.string().optional() })
        .safeParse(body.reaction);
      if (!parsed.success) return { ok: false, reason: 'reaction inválida' };
      event.reaction = { messageId: parsed.data.message_id, emoji: parsed.data.emoji };
      break;
    }
    default:
      break; // unsupported / unknown: só o envelope e os `errors`
  }
  return { ok: true, event };
}

function parseStatus(raw: unknown, origin: WebhookOrigin): Result<StatusUpdate> {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: formatIssue(parsed.error) };
  const s = parsed.data;
  const event: StatusUpdate = {
    kind: 'status',
    ...origin,
    messageId: s.id,
    status: s.status,
    timestamp: s.timestamp,
    recipientId: s.recipient_id,
  };
  if (s.conversation) {
    const expires = s.conversation.expiration_timestamp;
    event.conversation = {
      id: s.conversation.id,
      originType: s.conversation.origin?.type,
      expiresAt: expires === undefined ? undefined : new Date(Number(expires) * 1000),
    };
  }
  if (s.pricing) {
    event.pricing = {
      billable: s.pricing.billable,
      model: s.pricing.pricing_model,
      category: s.pricing.category,
    };
  }
  if (s.errors?.length) event.errors = s.errors.map(mapWebhookError);
  return { ok: true, event };
}

function observe(
  parsed: ParsedWebhook,
  options: ParseWebhookOptions,
  logger: WhatsAppLogger,
  metrics: WhatsAppMetrics,
): void {
  const tenant: Record<string, string> = options.tenantId ? { tenant_id: options.tenantId } : {};
  const phoneNumberIds = [...new Set(parsed.events.map((e) => e.phoneNumberId))];

  for (const event of parsed.events) {
    const label =
      event.kind === 'message' ? event.type : event.kind === 'status' ? event.status : 'system';
    metrics.increment(METRIC.webhookEvents, { ...tenant, kind: event.kind, type: label });
  }
  if (parsed.invalid.length) {
    metrics.increment(METRIC.webhookInvalid, tenant, parsed.invalid.length);
    logger.warn(
      {
        event: 'whatsapp.webhook.invalid',
        ...tenant,
        count: parsed.invalid.length,
        items: parsed.invalid,
      },
      'Itens inválidos no webhook do WhatsApp',
    );
  }
  logger.info(
    {
      event: 'whatsapp.webhook.parsed',
      ...tenant,
      phone_number_ids: phoneNumberIds,
      events: parsed.events.length,
      invalid: parsed.invalid.length,
      ignored: parsed.ignored,
    },
    'Webhook do WhatsApp interpretado',
  );
}

function formatIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'formato inválido';
  const where = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${where}${issue.message}`;
}
