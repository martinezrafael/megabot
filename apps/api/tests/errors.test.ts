import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { HttpAdapterHost } from '@nestjs/core';
import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter, normalizeException } from '../src/common/all-exceptions.filter';
import { startTestApp, type TestApp } from './helpers';

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId: string;
  path: string;
  timestamp: string;
  details?: Record<string, unknown>;
}

describe('Filtro global de erros', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  async function expectError(res: Response, status: number): Promise<ErrorBody> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /application\/json/);
    const body = (await res.json()) as ErrorBody;
    assert.equal(body.statusCode, status);
    assert.equal(body.requestId, res.headers.get('x-request-id'), 'requestId do corpo = cabeçalho');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
    return body;
  }

  it('401 em rota protegida', async () => {
    const body = await expectError(await t.api('/me'), 401);
    assert.equal(body.path, '/me');
    assert.equal(body.error, 'Unauthorized');
  });

  it('404 em rota inexistente tem o mesmo formato', async () => {
    const body = await expectError(await t.api('/nao-existe'), 404);
    assert.equal(body.error, 'Not Found');
    assert.equal(body.path, '/nao-existe');
  });

  it('400 para JSON inválido (erro do body-parser, não de um controller)', async () => {
    const body = await expectError(
      await t.api('/me', { method: 'POST', rawBody: '{json quebrado' }),
      400,
    );
    assert.equal(body.error, 'Bad Request');
  });

  it('413 para corpo grande demais', async () => {
    const body = await expectError(
      await t.api('/me', {
        method: 'POST',
        rawBody: JSON.stringify({ lixo: 'x'.repeat(200_000) }),
      }),
      413,
    );
    assert.equal(body.error, 'Payload Too Large');
  });

  it('a query string não aparece no campo path', async () => {
    const body = await expectError(await t.api('/me?token=segredo'), 401);
    assert.equal(body.path, '/me');
  });

  describe('normalizeException (unidade)', () => {
    it('mensagens de validação em lista viram uma frase', () => {
      const result = normalizeException(new BadRequestException(['email inválido', 'senha curta']));
      assert.equal(result.status, 400);
      assert.equal(result.message, 'email inválido; senha curta');
    });

    it('erro desconhecido vira 500 genérico SEM vazar detalhes', () => {
      const result = normalizeException(new Error('senha do banco = 123456'));
      assert.equal(result.status, 500);
      assert.ok(!result.message.includes('123456'));
    });
  });

  it('exceção inesperada: responde 500 genérico e registra o erro com request_id', () => {
    const logged: unknown[][] = [];
    const replies: { body: Record<string, unknown>; status: number }[] = [];
    const logger = {
      setContext: () => undefined,
      error: (...args: unknown[]) => void logged.push(args),
    } as unknown as PinoLogger;
    const adapterHost = {
      httpAdapter: {
        reply: (_res: unknown, body: Record<string, unknown>, status: number) =>
          replies.push({ body, status }),
      },
    } as unknown as HttpAdapterHost;

    const filter = new AllExceptionsFilter(adapterHost, logger);
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ id: 'req-12345678', originalUrl: '/boom?x=1' }),
        getResponse: () => ({ headersSent: false }),
      }),
    } as unknown as ArgumentsHost;

    filter.catch(new Error('segredo-interno-do-servidor'), host);

    assert.equal(replies.length, 1);
    assert.equal(replies[0].status, 500);
    assert.equal(replies[0].body.message, 'Erro interno do servidor.');
    assert.equal(replies[0].body.requestId, 'req-12345678');
    assert.equal(replies[0].body.path, '/boom');
    assert.ok(!JSON.stringify(replies[0].body).includes('segredo-interno'));

    assert.equal(logged.length, 1);
    assert.equal((logged[0][0] as { request_id: string }).request_id, 'req-12345678');
  });
});
