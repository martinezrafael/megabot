import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { StorageError, assertValidKey, type ObjectStorage } from './types';

/**
 * Driver S3. Serve para a Cloudflare R2 (que fala o protocolo do S3): basta apontar `endpoint`
 * para `https://<conta>.r2.cloudflarestorage.com` e usar `region: 'auto'`.
 *
 * Só o que precisamos: gravar, ler, apagar e checar. Sem URL pré-assinada por enquanto — o
 * upload passa pela API, que valida tipo e tamanho antes de guardar (ADR 0020).
 */

/** O mínimo que usamos do cliente da AWS: facilita trocar por um dublê nos testes. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface S3StorageOptions {
  bucket: string;
  region?: string;
  /** Obrigatório na R2 e em compatíveis (MinIO); vazio = AWS S3. */
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  /** R2 e MinIO precisam de caminho no lugar de subdomínio. */
  forcePathStyle?: boolean;
  /** Nome que aparece nos logs (`r2` ou `s3`). */
  driver?: string;
  client?: S3Like;
}

interface AwsError {
  name?: string;
  $metadata?: { httpStatusCode?: number };
}

export class S3ObjectStorage implements ObjectStorage {
  readonly driver: string;
  private readonly bucket: string;
  private readonly client: S3Like;

  constructor(options: S3StorageOptions) {
    if (!options.bucket?.trim()) {
      throw new StorageError('configuracao', 'STORAGE_BUCKET é obrigatório para o driver s3/r2.');
    }
    this.bucket = options.bucket;
    this.driver =
      options.driver ?? (options.endpoint?.includes('r2.cloudflarestorage.com') ? 'r2' : 's3');
    this.client =
      options.client ??
      new S3Client({
        region: options.region ?? 'auto',
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
        ...(options.accessKeyId && options.secretAccessKey
          ? {
              credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
              },
            }
          : {}),
      });
  }

  /** Erro da AWS -> erro nosso (com `retryable` para o job decidir se tenta de novo). */
  private fail(error: unknown, action: string): never {
    const aws = error as AwsError;
    const status = aws.$metadata?.httpStatusCode;
    if (aws.name === 'NoSuchKey' || aws.name === 'NotFound' || status === 404) {
      throw new StorageError('nao_encontrado', 'Arquivo não está mais no storage.', false, {
        cause: error,
      });
    }
    if (status === 401 || status === 403) {
      throw new StorageError(
        'configuracao',
        'O storage recusou o acesso: confira as credenciais e o nome do bucket.',
        false,
        { cause: error },
      );
    }
    throw new StorageError('indisponivel', `Falha ao ${action} o arquivo no storage.`, true, {
      cause: error,
    });
  }

  async put(key: string, bytes: Uint8Array, options: { contentType?: string } = {}): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: assertValidKey(key),
          Body: bytes,
          ContentLength: bytes.byteLength,
          ...(options.contentType ? { ContentType: options.contentType } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof StorageError) throw error;
      this.fail(error, 'gravar');
    }
  }

  async get(key: string): Promise<Uint8Array> {
    try {
      const response = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: assertValidKey(key) }),
      )) as { Body?: { transformToByteArray?: () => Promise<Uint8Array> } };
      const body = response.Body;
      if (!body?.transformToByteArray) {
        throw new StorageError('indisponivel', 'O storage devolveu uma resposta vazia.', true);
      }
      return await body.transformToByteArray();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      this.fail(error, 'ler');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: assertValidKey(key) }),
      );
    } catch (error) {
      if (error instanceof StorageError) throw error;
      // Apagar é idempotente: "não existe" é sucesso.
      const aws = error as AwsError;
      if (aws.name === 'NoSuchKey' || aws.$metadata?.httpStatusCode === 404) return;
      this.fail(error, 'apagar');
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: assertValidKey(key) }),
      );
      return true;
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const aws = error as AwsError;
      if (aws.name === 'NotFound' || aws.$metadata?.httpStatusCode === 404) return false;
      this.fail(error, 'consultar');
    }
  }
}
