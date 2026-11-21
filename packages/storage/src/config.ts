import { z } from 'zod';
import { LocalObjectStorage } from './local';
import { S3ObjectStorage } from './s3';
import { StorageError, type ObjectStorage } from './types';

/**
 * Configuração do storage, lida do ambiente.
 *
 *   STORAGE_DRIVER=local                      (padrão) guarda em STORAGE_LOCAL_DIR
 *   STORAGE_DRIVER=r2 | s3                    guarda no bucket (R2 ou S3)
 *
 * Para R2/S3: STORAGE_BUCKET, STORAGE_ENDPOINT (R2), STORAGE_REGION,
 * STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY.
 */
export type StorageDriver = 'local' | 's3' | 'r2';

export const DEFAULT_LOCAL_DIR = '.data/uploads';

const schema = z.object({
  STORAGE_DRIVER: z.enum(['local', 's3', 'r2']).default('local'),
  STORAGE_LOCAL_DIR: z.string().min(1).default(DEFAULT_LOCAL_DIR),
  STORAGE_BUCKET: z.string().min(1).optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_ENDPOINT: z.url({ error: 'precisa ser uma URL' }).optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
});

export interface StorageConfig {
  driver: StorageDriver;
  localDir: string;
  bucket?: string | undefined;
  region?: string | undefined;
  endpoint?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  forcePathStyle?: boolean | undefined;
}

/** Lê a configuração. Lança `StorageError('configuracao')` com TODOS os problemas de uma vez. */
export function loadStorageConfig(
  env: Record<string, string | undefined> = process.env,
): StorageConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new StorageError(
      'configuracao',
      `Configuração de storage inválida:\n - ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
        .join('\n - ')}`,
    );
  }
  const e = parsed.data;

  if (e.STORAGE_DRIVER !== 'local') {
    const missing = [
      ...(e.STORAGE_BUCKET ? [] : ['STORAGE_BUCKET']),
      ...(e.STORAGE_ACCESS_KEY_ID ? [] : ['STORAGE_ACCESS_KEY_ID']),
      ...(e.STORAGE_SECRET_ACCESS_KEY ? [] : ['STORAGE_SECRET_ACCESS_KEY']),
      ...(e.STORAGE_DRIVER === 'r2' && !e.STORAGE_ENDPOINT ? ['STORAGE_ENDPOINT'] : []),
    ];
    if (missing.length > 0) {
      throw new StorageError(
        'configuracao',
        `STORAGE_DRIVER=${e.STORAGE_DRIVER} exige: ${missing.join(', ')}.`,
      );
    }
  }

  return {
    driver: e.STORAGE_DRIVER,
    localDir: e.STORAGE_LOCAL_DIR,
    bucket: e.STORAGE_BUCKET,
    region: e.STORAGE_REGION,
    endpoint: e.STORAGE_ENDPOINT,
    accessKeyId: e.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY,
    forcePathStyle: e.STORAGE_FORCE_PATH_STYLE ? e.STORAGE_FORCE_PATH_STYLE === 'true' : undefined,
  };
}

/** Monta o driver a partir da configuração. */
export function createStorage(config: StorageConfig): ObjectStorage {
  if (config.driver === 'local') return new LocalObjectStorage(config.localDir);
  return new S3ObjectStorage({
    bucket: config.bucket ?? '',
    region: config.region ?? 'auto',
    endpoint: config.endpoint,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    driver: config.driver,
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
  });
}

export const createStorageFromEnv = (
  env: Record<string, string | undefined> = process.env,
): ObjectStorage => createStorage(loadStorageConfig(env));
