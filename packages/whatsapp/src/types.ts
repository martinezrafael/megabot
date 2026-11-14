/** Tipos públicos de ENVIO para a Cloud API. */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/** Mídia já enviada à Meta (`id`) OU hospedada por nós em URL pública HTTPS (`link`). */
export type MediaSource = { id: string; link?: never } | { link: string; id?: never };

export interface SendTextInput {
  /** Telefone do contato (aceita "+55 (11) 99999-9999"; é normalizado para só dígitos). */
  to: string;
  body: string;
  /** Mostra pré-visualização do primeiro link do texto. */
  previewUrl?: boolean;
  /** Responde (cita) uma mensagem anterior. */
  replyToMessageId?: string;
}

export type TemplateParameter =
  | { type: 'text'; text: string; parameter_name?: string }
  | { type: 'currency'; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: 'date_time'; date_time: { fallback_value: string } }
  | { type: 'image'; image: MediaSource }
  | { type: 'video'; video: MediaSource }
  | { type: 'document'; document: MediaSource & { filename?: string } }
  | { type: 'payload'; payload: string };

export type TemplateComponent =
  | { type: 'header' | 'body'; parameters: TemplateParameter[] }
  | {
      type: 'button';
      sub_type: 'quick_reply' | 'url';
      index: number;
      parameters: TemplateParameter[];
    };

export interface SendTemplateInput {
  to: string;
  /** Nome do template aprovado. */
  name: string;
  /** Idioma do template, ex.: "pt_BR". */
  language: string;
  components?: TemplateComponent[];
  replyToMessageId?: string;
}

export interface SendMediaInput {
  to: string;
  kind: MediaKind;
  media: MediaSource;
  /** Legenda. Não existe para áudio e figurinha. */
  caption?: string;
  /** Nome do arquivo exibido. Só para documento. */
  filename?: string;
  replyToMessageId?: string;
}

export interface SendResult {
  /** Id da mensagem (`wamid...`): é com ele que chegam os webhooks de status. */
  messageId: string;
  /** Número como o WhatsApp o reconhece (`wa_id`). Pode diferir do que enviamos. */
  waId: string | undefined;
  /** Número exatamente como enviamos (normalizado). */
  input: string | undefined;
}

export interface UploadMediaInput {
  data: Uint8Array;
  mimeType: string;
  /** Nome do arquivo (obrigatório para documentos que serão exibidos com nome). */
  filename?: string;
}

export interface MediaMetadata {
  id: string;
  /** URL temporária (expira em ~5 minutos). Exige o token para baixar. */
  url: string;
  mimeType: string;
  sha256: string | undefined;
  fileSize: number | undefined;
}

export interface DownloadedMedia {
  data: Buffer;
  mimeType: string;
  sha256: string | undefined;
}
