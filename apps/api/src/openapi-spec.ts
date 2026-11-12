import type { OpenAPIObject } from '@nestjs/swagger';
import { createApp } from './bootstrap';
import type { AppConfig } from './config';
import { createMemoryMailer } from './mailer';
import { buildOpenApiDocument } from './openapi';

/** Configuração FIXA e sem segredos: o contrato não pode depender do ambiente de quem o gera. */
const SPEC_CONFIG: AppConfig = {
  env: 'test',
  port: 3000,
  authUrl: 'http://localhost:3000',
  webUrl: 'http://localhost:3001',
  authSecret: 'openapi-spec-generation-only-not-a-real-secret',
  google: { clientId: 'spec', clientSecret: 'spec' },
  smtp: { host: 'localhost', port: 1025, from: 'spec@megabot.local' },
  logLevel: 'silent',
  rateLimit: { windowMs: 60_000, max: 1000, authMax: 1000 },
  trustProxy: false,
  swaggerEnabled: false,
};

/** Gera o contrato OpenAPI sem depender de .env, banco ou rede. */
export async function generateOpenApiSpec(): Promise<OpenAPIObject> {
  const app = await createApp({ config: SPEC_CONFIG, mailer: createMemoryMailer() });
  try {
    return await buildOpenApiDocument(app, SPEC_CONFIG);
  } finally {
    await app.close();
  }
}
