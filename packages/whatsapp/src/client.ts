import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  WhatsAppApiError,
  WhatsAppError,
  WhatsAppNetworkError,
  WhatsAppValidationError,
  parseGraphError,
} from './errors';
import {
  METRIC,
  maskPhone,
  noopLogger,
  noopMetrics,
  type LogFields,
  type WhatsAppLogger,
  type WhatsAppMetrics,
} from './observability';
import type {
  DownloadedMedia,
  MediaKind,
  MediaMetadata,
  MediaSource,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  UploadMediaInput,
} from './types';
import {
  MAX_CAPTION_LENGTH,
  MAX_DOWNLOAD_BYTES,
  assertHttpsUrl,
  assertMediaUpload,
  assertText,
  mediaKindFromMime,
  normalizePhone,
} from './validation';

export const DEFAULT_API_VERSION = 'v23.0';
export const DEFAULT_BASE_URL = 'https://graph.facebook.com';
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface WhatsAppClientOptions {
  /** Token de acesso (de sistema) da Meta. Nunca é logado. */
  accessToken: string;
  /** Id do número de telefone da empresa (`phone_number_id`), só dígitos. */
  phoneNumberId: string;
  /** Tenant dono desta conexão: aparece em todo log e métrica. */
  tenantId: string;
  /** Versão do Graph API. Configurável porque a Meta aposenta versões antigas. */
  apiVersion?: string;
  baseUrl?: string;
  /** Tempo máximo por requisição (ms). Padrão: 15s. */
  timeoutMs?: number;
  logger?: WhatsAppLogger;
  metrics?: WhatsAppMetrics;
  /** Injetável para testes. Padrão: `fetch` global do Node. */
  fetch?: typeof fetch;
}

const sendResponseSchema = z.looseObject({
  messages: z.array(z.looseObject({ id: z.string() })).min(1),
  contacts: z
    .array(z.looseObject({ input: z.string().optional(), wa_id: z.string().optional() }))
    .optional(),
});
const idResponseSchema = z.looseObject({ id: z.string() });
const successResponseSchema = z.looseObject({ success: z.boolean() });
const mediaMetadataSchema = z.looseObject({
  id: z.string(),
  url: z.string(),
  mime_type: z.string(),
  sha256: z.string().optional(),
  file_size: z.union([z.number(), z.string()]).optional(),
});

interface Outcome<T> {
  value: T;
  httpStatus: number;
  /** Campos extras para o log de sucesso (ex.: id da mensagem). */
  log?: LogFields;
}

/**
 * Cliente da WhatsApp Cloud API para UM número de telefone de UM tenant.
 *
 * - Não faz retentativa interna: devolve `retryable` e quem chama (pg-boss) decide, com idempotência.
 * - Toda chamada gera um log estruturado e métricas com `tenant_id`.
 */
export class WhatsAppClient {
  private readonly accessToken: string;
  private readonly phoneNumberId: string;
  private readonly tenantId: string;
  private readonly graphUrl: string;
  private readonly timeoutMs: number;
  private readonly logger: WhatsAppLogger;
  private readonly metrics: WhatsAppMetrics;
  private readonly fetchImpl: typeof fetch;

  constructor(options: WhatsAppClientOptions) {
    if (!options.accessToken.trim())
      throw new WhatsAppValidationError('accessToken é obrigatório.');
    if (!/^\d+$/.test(options.phoneNumberId)) {
      throw new WhatsAppValidationError('phoneNumberId deve conter apenas dígitos.');
    }
    if (!options.tenantId.trim()) throw new WhatsAppValidationError('tenantId é obrigatório.');

    this.accessToken = options.accessToken;
    this.phoneNumberId = options.phoneNumberId;
    this.tenantId = options.tenantId;
    this.graphUrl = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/${options.apiVersion ?? DEFAULT_API_VERSION}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.fetchImpl = options.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- envio

  async sendText(input: SendTextInput): Promise<SendResult> {
    const to = normalizePhone(input.to);
    assertText(input.body);
    return this.send('send_text', to, {
      type: 'text',
      text: { body: input.body, preview_url: input.previewUrl ?? false },
      ...replyContext(input.replyToMessageId),
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const to = normalizePhone(input.to);
    if (!/^[a-z0-9_]{1,512}$/.test(input.name)) {
      throw new WhatsAppValidationError('Nome de template inválido (use minúsculas, números e _).');
    }
    if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(input.language)) {
      throw new WhatsAppValidationError('Idioma do template inválido (ex.: pt_BR).');
    }
    return this.send('send_template', to, {
      type: 'template',
      template: {
        name: input.name,
        language: { code: input.language },
        ...(input.components?.length ? { components: input.components } : {}),
      },
      ...replyContext(input.replyToMessageId),
    });
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const to = normalizePhone(input.to);
    const { kind } = input;
    validateMediaSource(input.media);
    if (input.caption !== undefined) {
      if (kind === 'audio' || kind === 'sticker') {
        throw new WhatsAppValidationError(`${kind} não aceita legenda.`);
      }
      if (input.caption.length > MAX_CAPTION_LENGTH) {
        throw new WhatsAppValidationError(`Legenda acima de ${MAX_CAPTION_LENGTH} caracteres.`);
      }
    }
    if (input.filename !== undefined && kind !== 'document') {
      throw new WhatsAppValidationError('filename só vale para documento.');
    }
    return this.send(`send_${kind}`, to, {
      type: kind,
      [kind]: {
        ...input.media,
        ...(input.caption !== undefined ? { caption: input.caption } : {}),
        ...(input.filename !== undefined ? { filename: input.filename } : {}),
      },
      ...replyContext(input.replyToMessageId),
    });
  }

  /** Marca uma mensagem recebida como lida (mostra o "visto" azul para o cliente). */
  async markAsRead(messageId: string): Promise<void> {
    if (!messageId) throw new WhatsAppValidationError('messageId é obrigatório.');
    await this.instrument('mark_read', {}, async () => {
      const res = await this.rawRequest('POST', `${this.graphUrl}/${this.phoneNumberId}/messages`, {
        json: { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      });
      successResponseSchema.parse(await res.json());
      return { value: undefined, httpStatus: res.status, log: { message_id: messageId } };
    });
  }

  // ---------------------------------------------------------------- mídia

  /** Sobe um arquivo para a Meta e devolve o `id` para usar em `sendMedia`. */
  async uploadMedia(input: UploadMediaInput): Promise<{ id: string }> {
    const kind =
      mediaKindFromMime(input.mimeType) ??
      (input.mimeType === 'image/webp' ? 'sticker' : undefined);
    if (!kind) throw new WhatsAppValidationError(`Tipo "${input.mimeType}" não é suportado.`);
    assertMediaUpload(kind, input.mimeType, input.data.byteLength);

    return this.instrument(
      'upload_media',
      { media_kind: kind, size: input.data.byteLength },
      async () => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append(
          'file',
          new Blob([input.data as BlobPart], { type: input.mimeType }),
          input.filename ?? 'arquivo',
        );
        const res = await this.rawRequest('POST', `${this.graphUrl}/${this.phoneNumberId}/media`, {
          form,
        });
        const { id } = idResponseSchema.parse(await res.json());
        return { value: { id }, httpStatus: res.status, log: { media_id: id } };
      },
    );
  }

  /** Consulta a URL temporária (≈5 min) e os metadados de uma mídia. */
  async getMediaUrl(mediaId: string): Promise<MediaMetadata> {
    assertId(mediaId, 'mediaId');
    return this.instrument('get_media_url', { media_id: mediaId }, async () => {
      const res = await this.rawRequest('GET', `${this.graphUrl}/${mediaId}`);
      const body = mediaMetadataSchema.parse(await res.json());
      const fileSize = body.file_size === undefined ? undefined : Number(body.file_size);
      return {
        value: {
          id: body.id,
          url: body.url,
          mimeType: body.mime_type,
          sha256: body.sha256,
          fileSize: Number.isFinite(fileSize) ? fileSize : undefined,
        },
        httpStatus: res.status,
      };
    });
  }

  /**
   * Baixa uma mídia recebida. Passos: pede a URL temporária, baixa com o token, confere o tamanho
   * e o SHA-256. Se a URL expirar (404) pede outra uma única vez.
   */
  async downloadMedia(
    mediaId: string,
    options: { maxBytes?: number; verifySha256?: boolean } = {},
  ): Promise<DownloadedMedia> {
    assertId(mediaId, 'mediaId');
    const maxBytes = Math.min(options.maxBytes ?? MAX_DOWNLOAD_BYTES, MAX_DOWNLOAD_BYTES);

    return this.instrument('download_media', { media_id: mediaId }, async () => {
      let meta = await this.getMediaUrl(mediaId);
      let res: Response;
      try {
        res = await this.rawRequest('GET', safeMediaUrl(meta.url));
      } catch (error) {
        if (!(error instanceof WhatsAppApiError) || error.httpStatus !== 404) throw error;
        meta = await this.getMediaUrl(mediaId);
        res = await this.rawRequest('GET', safeMediaUrl(meta.url));
      }

      const declared = Number(res.headers.get('content-length') ?? '0');
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new WhatsAppError(`Mídia maior que o limite de ${maxBytes} bytes.`, {
          category: 'media',
          retryable: false,
        });
      }
      const data = await readLimited(res, maxBytes);

      if ((options.verifySha256 ?? true) && meta.sha256) {
        const actual = createHash('sha256').update(data).digest('hex');
        if (actual.toLowerCase() !== meta.sha256.toLowerCase()) {
          throw new WhatsAppError('SHA-256 da mídia baixada não confere (arquivo corrompido).', {
            category: 'media',
            retryable: true,
          });
        }
      }

      return {
        value: {
          data,
          mimeType: res.headers.get('content-type') ?? meta.mimeType,
          sha256: meta.sha256,
        },
        httpStatus: res.status,
        log: { size: data.byteLength },
      };
    });
  }

  async deleteMedia(mediaId: string): Promise<void> {
    assertId(mediaId, 'mediaId');
    await this.instrument('delete_media', { media_id: mediaId }, async () => {
      const res = await this.rawRequest('DELETE', `${this.graphUrl}/${mediaId}`);
      successResponseSchema.parse(await res.json());
      return { value: undefined, httpStatus: res.status };
    });
  }

  // ------------------------------------------------------------- internos

  private send(
    operation: string,
    to: string,
    payload: Record<string, unknown>,
  ): Promise<SendResult> {
    return this.instrument(operation, { to_suffix: maskPhone(to) }, async () => {
      const res = await this.rawRequest('POST', `${this.graphUrl}/${this.phoneNumberId}/messages`, {
        json: { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload },
      });
      const body = sendResponseSchema.parse(await res.json());
      const messageId = body.messages[0]!.id;
      const contact = body.contacts?.[0];
      return {
        value: { messageId, waId: contact?.wa_id, input: contact?.input },
        httpStatus: res.status,
        log: { message_id: messageId },
      };
    });
  }

  /** Faz a requisição HTTP, aplica timeout e converte falhas em erros tipados. */
  private async rawRequest(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body: { json?: unknown; form?: FormData } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    let payload: string | FormData | undefined;
    if (body.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body.form) {
      payload = body.form; // o fetch define o Content-Type multipart com o boundary
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new WhatsAppNetworkError(
        timedOut ? `Tempo esgotado após ${this.timeoutMs} ms.` : 'Falha de rede ao chamar a Meta.',
        { timedOut, cause: error },
      );
    }

    if (!res.ok) {
      let errorBody: unknown;
      try {
        errorBody = await res.json();
      } catch {
        errorBody = undefined;
      }
      throw parseGraphError(errorBody, res.status);
    }
    return res;
  }

  /** Mede, loga e emite métricas de uma operação. Também normaliza erros inesperados (ex.: JSON fora do formato). */
  private async instrument<T>(
    operation: string,
    fields: LogFields,
    fn: () => Promise<Outcome<T>>,
  ): Promise<T> {
    const started = performance.now();
    const base = {
      event: 'whatsapp.request',
      tenant_id: this.tenantId,
      phone_number_id: this.phoneNumberId,
      operation,
      ...fields,
    };
    const labels = { tenant_id: this.tenantId, operation };

    try {
      const outcome = await fn();
      const durationMs = Math.round(performance.now() - started);
      this.logger.info(
        {
          ...base,
          ...outcome.log,
          outcome: 'success',
          status: outcome.httpStatus,
          duration_ms: durationMs,
        },
        'WhatsApp API ok',
      );
      this.metrics.increment(METRIC.requests, { ...labels, outcome: 'success' });
      this.metrics.timing(METRIC.requestDuration, durationMs, labels);
      return outcome.value;
    } catch (raw) {
      const error = this.normalizeError(raw);
      const durationMs = Math.round(performance.now() - started);
      const level = error.retryable ? 'warn' : 'error';
      this.logger[level](
        {
          ...base,
          outcome: 'error',
          duration_ms: durationMs,
          error_name: error.name,
          error_category: error.category,
          retryable: error.retryable,
          ...(error instanceof WhatsAppApiError
            ? {
                status: error.httpStatus,
                error_code: error.code,
                error_subcode: error.subcode,
                fbtrace_id: error.fbtraceId,
              }
            : {}),
        },
        'WhatsApp API falhou',
      );
      this.metrics.increment(METRIC.requests, {
        ...labels,
        outcome: 'error',
        error_category: error.category,
      });
      this.metrics.timing(METRIC.requestDuration, durationMs, labels);
      throw error;
    }
  }

  private normalizeError(error: unknown): WhatsAppError {
    if (error instanceof WhatsAppError) return error;
    if (error instanceof z.ZodError) {
      return new WhatsAppError('Resposta da Meta fora do formato esperado.', {
        category: 'unknown',
        retryable: false,
        cause: error,
      });
    }
    return new WhatsAppError('Erro inesperado no cliente WhatsApp.', {
      category: 'unknown',
      retryable: false,
      cause: error,
    });
  }
}

function replyContext(messageId: string | undefined): Record<string, unknown> {
  return messageId ? { context: { message_id: messageId } } : {};
}

function validateMediaSource(source: MediaSource): void {
  if ('id' in source && source.id !== undefined) {
    if (!source.id.trim()) throw new WhatsAppValidationError('media.id vazio.');
    if ('link' in source && source.link !== undefined) {
      throw new WhatsAppValidationError('Informe media.id OU media.link, não os dois.');
    }
    return;
  }
  if ('link' in source && source.link !== undefined) {
    assertHttpsUrl(source.link, 'media.link');
    return;
  }
  throw new WhatsAppValidationError('Informe media.id ou media.link.');
}

function assertId(value: string, name: string): void {
  if (!/^[\w-]+$/.test(value)) throw new WhatsAppValidationError(`${name} inválido.`);
}

/** A URL da mídia vem da Meta, mas só enviamos o token para HTTPS. */
function safeMediaUrl(url: string): string {
  assertHttpsUrl(url, 'URL da mídia');
  return url;
}

/** Lê o corpo respeitando o limite, sem carregar arquivos gigantes na memória. */
async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WhatsAppError(`Mídia maior que o limite de ${maxBytes} bytes.`, {
        category: 'media',
        retryable: false,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export type { MediaKind };
