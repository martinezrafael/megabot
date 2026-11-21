import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { json, type NextFunction, type Request, type Response } from 'express';
import { Logger } from 'nestjs-pino';
import { AppModule, type AppModuleOptions } from './app.module';
import { REQUEST_ID_HEADER, requestIdMiddleware } from './logging/request-id';
import { setupSwagger } from './openapi';

const parseJson = json({ limit: '100kb' });

/**
 * Criar fonte por texto colado pode ser um FAQ inteiro, bem maior que os 100 kB das outras rotas.
 * O conteúdo ainda é limitado no serviço (MAX_PASTED_TEXT), que devolve 400 com explicação.
 */
const KNOWLEDGE_SOURCES_PATH = '/knowledge/sources';
const parseBigJson = json({ limit: '2mb' });

/**
 * Webhook do WhatsApp: a assinatura (X-Hub-Signature-256) é calculada sobre os BYTES exatos
 * do corpo. Se o corpo passasse por JSON.parse antes, qualquer diferença de formatação
 * (espaços, ordem, escape de unicode) invalidaria a conferência. Por isso guardamos o Buffer.
 * Limite de 3 MB: é o tamanho máximo que a Meta anuncia para um webhook.
 */
const WHATSAPP_WEBHOOK_PATH = '/webhooks/whatsapp';
const parseRaw = express.raw({ type: () => true, limit: '3mb' });

/**
 * Upload da base de conhecimento (T2.2): o corpo é o ARQUIVO, então também vai cru. Sem multipart
 * de propósito — um arquivo por requisição é mais simples de validar, de testar e de mandar do
 * navegador (`fetch(url, { body: file })`). O limite vem da configuração (KNOWLEDGE_MAX_UPLOAD_MB).
 */
const KNOWLEDGE_UPLOAD_PATH = '/knowledge/sources/upload';

/**
 * Escolhe o parser de corpo por rota:
 * - /api/auth: nenhum (o Better Auth precisa do stream ainda não lido);
 * - /webhooks/whatsapp: corpo cru (Buffer), para conferir a assinatura;
 * - /knowledge/sources/upload: corpo cru (Buffer), que é o próprio arquivo;
 * - /knowledge/sources: JSON com limite maior (texto colado);
 * - demais: JSON.
 */
function bodyParserByRoute(parseUpload: express.RequestHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api/auth')) return next();
    if (req.path === WHATSAPP_WEBHOOK_PATH) return parseRaw(req, res, next);
    if (req.path === KNOWLEDGE_UPLOAD_PATH) return parseUpload(req, res, next);
    if (req.path === KNOWLEDGE_SOURCES_PATH) return parseBigJson(req, res, next);
    return parseJson(req, res, next);
  };
}

/**
 * Monta a aplicação. Usado pelo main.ts, pelo gerador de OpenAPI e pelos testes.
 */
export async function createApp(options: AppModuleOptions): Promise<NestExpressApplication> {
  const { config } = options;

  // bodyParser: false -> registramos o nosso parser logo abaixo (ver bodyParserByRoute).
  // bufferLogs: guarda os logs de inicialização até o pino estar pronto.
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(options), {
    bodyParser: false,
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  // Atrás de proxy/load balancer, é o que faz o rate limit enxergar o IP real.
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');

  // Request id o mais cedo possível: até erros de body-parser saem com ele.
  app.use(requestIdMiddleware);

  // CORS: só o nosso front-end, com cookies (credentials).
  app.enableCors({
    origin: config.webUrl,
    credentials: true,
    exposedHeaders: [REQUEST_ID_HEADER, 'retry-after'],
  });

  app.use(
    bodyParserByRoute(express.raw({ type: () => true, limit: config.knowledge.maxUploadBytes })),
  );

  if (config.swaggerEnabled) await setupSwagger(app, config);

  return app;
}
