import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { createAuth } from './auth/auth';
import type { AppConfig } from './config';
import { createMemoryMailer } from './mailer';

/** Onde o Better Auth monta suas rotas (ver AuthController). */
const AUTH_BASE_PATH = '/api/auth';

/**
 * Só documentamos as rotas do Better Auth que o produto realmente usa.
 * (O Better Auth descreve também rotas que não habilitamos, como delete-user.)
 */
const SUPPORTED_AUTH_PATHS = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/sign-in/social',
  '/callback/{id}',
  '/sign-out',
  '/get-session',
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/{token}',
]);

/**
 * Monta o contrato OpenAPI COMPLETO: rotas do Nest (/health, /me...) + rotas de
 * autenticação do Better Auth (/api/auth/...). Não precisa de banco nem de rede.
 */
export async function buildOpenApiDocument(
  app: INestApplication,
  config: AppConfig,
): Promise<OpenAPIObject> {
  const builder = new DocumentBuilder()
    .setTitle('Megabot API')
    .setDescription(
      'Contrato da API do Megabot. Erros seguem o formato ErrorResponseDto. ' +
        'Autenticação por cookie de sessão (better-auth.session_token).',
    )
    .setVersion('1.0.0')
    .addCookieAuth(
      'better-auth.session_token',
      { type: 'apiKey', in: 'cookie', name: 'better-auth.session_token' },
      'session',
    )
    .build();

  const document = SwaggerModule.createDocument(app, builder);

  // O Better Auth descreve as próprias rotas (caminhos relativos a /api/auth).
  // Esta instância existe só para descrever; nunca atende requisições.
  const describer = createAuth({ config, mailer: createMemoryMailer(), openApi: true });
  const authSpec = (await describer.api.generateOpenAPISchema()) as unknown as {
    paths: Record<string, unknown>;
    components?: { schemas?: Record<string, unknown> };
  };

  for (const [path, item] of Object.entries(authSpec.paths)) {
    if (SUPPORTED_AUTH_PATHS.has(path)) document.paths[`${AUTH_BASE_PATH}${path}`] = item as never;
  }
  document.components ??= {};
  document.components.schemas = {
    ...(authSpec.components?.schemas as Record<string, never> | undefined),
    ...document.components.schemas,
  };
  pruneUnusedSchemas(document);

  return sortKeys(document) as OpenAPIObject;
}

/** Documentação interativa em /docs e o JSON em /docs/openapi.json. */
export async function setupSwagger(app: INestApplication, config: AppConfig): Promise<void> {
  const document = await buildOpenApiDocument(app, config);
  SwaggerModule.setup('docs', app, document, { jsonDocumentUrl: 'docs/openapi.json' });
}

/** Ordena as chaves para o arquivo gerado ser estável (diffs limpos no Git). */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** Remove de `components.schemas` tudo que nenhuma rota referencia (direta ou indiretamente). */
function pruneUnusedSchemas(document: OpenAPIObject): void {
  const schemas = (document.components?.schemas ?? {}) as Record<string, unknown>;
  const used = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (
        key === '$ref' &&
        typeof value === 'string' &&
        value.startsWith('#/components/schemas/')
      ) {
        const name = value.slice('#/components/schemas/'.length);
        if (!used.has(name)) {
          used.add(name);
          visit(schemas[name]);
        }
      } else {
        visit(value);
      }
    }
  };

  visit(document.paths);
  for (const name of Object.keys(schemas)) {
    if (!used.has(name)) delete schemas[name];
  }
}
