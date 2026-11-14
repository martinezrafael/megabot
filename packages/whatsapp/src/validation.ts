import { WhatsAppValidationError } from './errors';
import type { MediaKind } from './types';

/** Limite do corpo de texto na Cloud API. */
export const MAX_TEXT_LENGTH = 4096;
/** Legenda de mídia. */
export const MAX_CAPTION_LENGTH = 1024;

const MB = 1024 * 1024;

/**
 * Formatos e tamanhos aceitos no UPLOAD (documentação de mídia da Cloud API).
 * Validamos antes para falhar rápido, sem gastar uma chamada à Meta.
 */
export const MEDIA_LIMITS: Record<MediaKind, { maxBytes: number; mimeTypes: readonly string[] }> = {
  image: { maxBytes: 5 * MB, mimeTypes: ['image/jpeg', 'image/png'] },
  video: { maxBytes: 16 * MB, mimeTypes: ['video/mp4', 'video/3gpp'] },
  audio: {
    maxBytes: 16 * MB,
    mimeTypes: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
  },
  document: {
    maxBytes: 100 * MB,
    mimeTypes: [
      'text/plain',
      'application/pdf',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  sticker: { maxBytes: 500 * 1024, mimeTypes: ['image/webp'] },
};

/** Tamanho máximo de mídia recebida que a Meta entrega (100 MB). */
export const MAX_DOWNLOAD_BYTES = 100 * MB;

/** "+55 (11) 99999-9999" -> "5511999999999". Aceita de 7 a 15 dígitos (limite do E.164). */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[\s()+.-]/g, '');
  if (!/^\d{7,15}$/.test(digits)) {
    throw new WhatsAppValidationError(
      'Telefone inválido: use o número com código do país (ex.: 5511999999999).',
    );
  }
  return digits;
}

export function assertText(body: string): void {
  if (typeof body !== 'string' || body.trim() === '') {
    throw new WhatsAppValidationError('O texto da mensagem não pode ser vazio.');
  }
  if (body.length > MAX_TEXT_LENGTH) {
    throw new WhatsAppValidationError(`Texto acima de ${MAX_TEXT_LENGTH} caracteres.`);
  }
}

export function assertMediaUpload(kind: MediaKind, mimeType: string, size: number): void {
  const limits = MEDIA_LIMITS[kind];
  // "audio/ogg; codecs=opus" -> "audio/ogg"
  const baseMime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  if (!limits.mimeTypes.includes(baseMime)) {
    throw new WhatsAppValidationError(`Tipo "${mimeType}" não é aceito para ${kind}.`);
  }
  if (size <= 0) throw new WhatsAppValidationError('Arquivo vazio.');
  if (size > limits.maxBytes) {
    throw new WhatsAppValidationError(
      `Arquivo de ${kind} acima do limite de ${Math.round(limits.maxBytes / 1024)} KB.`,
    );
  }
}

/** Descobre a categoria de mídia a partir do mime, para quem só tem o `mimeType` (ex.: upload). */
export function mediaKindFromMime(mimeType: string): MediaKind | undefined {
  const baseMime = (mimeType.split(';')[0] ?? '').trim().toLowerCase();
  // sticker e image/webp: só dá para decidir pelo contexto de envio, então não entra aqui.
  for (const kind of ['image', 'video', 'audio', 'document'] as const) {
    if (MEDIA_LIMITS[kind].mimeTypes.includes(baseMime)) return kind;
  }
  return undefined;
}

export function assertHttpsUrl(url: string, what: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new WhatsAppValidationError(`${what} não é uma URL válida.`);
  }
  if (parsed.protocol !== 'https:') {
    throw new WhatsAppValidationError(`${what} precisa usar HTTPS.`);
  }
}
