import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  WhatsAppApiError,
  WhatsAppClient,
  WhatsAppNetworkError,
  WhatsAppValidationError,
} from '../src';
import { captureLogs, captureMetrics, fakeFetch, json } from './helpers';

const TOKEN = 'EAAG-token-super-secreto';
const OK_SEND = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '5511999990000', wa_id: '5511999990000' }],
  messages: [{ id: 'wamid.OUT1' }],
};

function make(
  responders: Parameters<typeof fakeFetch>[0],
  extra: Partial<ConstructorParameters<typeof WhatsAppClient>[0]> = {},
) {
  const f = fakeFetch(responders);
  const logs = captureLogs();
  const m = captureMetrics();
  const client = new WhatsAppClient({
    accessToken: TOKEN,
    phoneNumberId: '106540352242922',
    tenantId: 'tenant-1',
    fetch: f.fetch,
    logger: logs.logger,
    metrics: m.metrics,
    ...extra,
  });
  return { client, ...f, ...logs, ...m };
}

describe('WhatsAppClient — construtor', () => {
  it('valida opções', () => {
    const base = { accessToken: 't', phoneNumberId: '1', tenantId: 'x' };
    assert.throws(() => new WhatsAppClient({ ...base, accessToken: ' ' }), WhatsAppValidationError);
    assert.throws(
      () => new WhatsAppClient({ ...base, phoneNumberId: 'abc' }),
      WhatsAppValidationError,
    );
    assert.throws(() => new WhatsAppClient({ ...base, tenantId: '' }), WhatsAppValidationError);
  });
});

describe('WhatsAppClient — texto', () => {
  it('envia texto com o formato da Cloud API', async () => {
    const t = make([json(OK_SEND)]);
    const result = await t.client.sendText({ to: '+55 (11) 99999-0000', body: 'Olá!' });

    assert.deepEqual(result, {
      messageId: 'wamid.OUT1',
      waId: '5511999990000',
      input: '5511999990000',
    });
    const call = t.calls[0]!;
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://graph.facebook.com/v23.0/106540352242922/messages');
    assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(call.body, {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511999990000',
      type: 'text',
      text: { body: 'Olá!', preview_url: false },
    });
  });

  it('suporta resposta a mensagem (context) e versão/base configuráveis', async () => {
    const t = make([json(OK_SEND)], { apiVersion: 'v24.0', baseUrl: 'https://exemplo.test/' });
    await t.client.sendText({
      to: '5511999990000',
      body: 'ok',
      previewUrl: true,
      replyToMessageId: 'wamid.IN',
    });
    assert.equal(t.calls[0]!.url, 'https://exemplo.test/v24.0/106540352242922/messages');
    const body = t.calls[0]!.body as Record<string, unknown>;
    assert.deepEqual(body.context, { message_id: 'wamid.IN' });
    assert.deepEqual(body.text, { body: 'ok', preview_url: true });
  });

  it('rejeita entrada inválida SEM chamar a Meta', async () => {
    const t = make([]);
    await assert.rejects(t.client.sendText({ to: '123', body: 'x' }), WhatsAppValidationError);
    await assert.rejects(
      t.client.sendText({ to: '5511999990000', body: '   ' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendText({ to: '5511999990000', body: 'a'.repeat(4097) }),
      WhatsAppValidationError,
    );
    assert.equal(t.calls.length, 0);
  });
});

describe('WhatsAppClient — template', () => {
  it('envia template com componentes', async () => {
    const t = make([json(OK_SEND)]);
    await t.client.sendTemplate({
      to: '5511999990000',
      name: 'confirmacao_pedido',
      language: 'pt_BR',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }],
    });
    const body = t.calls[0]!.body as Record<string, unknown>;
    assert.equal(body.type, 'template');
    assert.deepEqual(body.template, {
      name: 'confirmacao_pedido',
      language: { code: 'pt_BR' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }],
    });
  });

  it('sem componentes não envia o campo; valida nome e idioma', async () => {
    const t = make([json(OK_SEND)]);
    await t.client.sendTemplate({ to: '5511999990000', name: 'hello_world', language: 'en_US' });
    assert.deepEqual((t.calls[0]!.body as { template: unknown }).template, {
      name: 'hello_world',
      language: { code: 'en_US' },
    });
    await assert.rejects(
      t.client.sendTemplate({ to: '5511999990000', name: 'Nome Inválido', language: 'pt_BR' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendTemplate({ to: '5511999990000', name: 'ok', language: 'portugues' }),
      WhatsAppValidationError,
    );
  });
});

describe('WhatsAppClient — mídia (envio)', () => {
  it('envia imagem por id com legenda e documento por link com filename', async () => {
    const t = make([json(OK_SEND), json(OK_SEND)]);
    await t.client.sendMedia({
      to: '5511999990000',
      kind: 'image',
      media: { id: 'MEDIA1' },
      caption: 'Foto',
    });
    await t.client.sendMedia({
      to: '5511999990000',
      kind: 'document',
      media: { link: 'https://cdn.exemplo.com/a.pdf' },
      filename: 'a.pdf',
    });
    assert.deepEqual((t.calls[0]!.body as Record<string, unknown>).image, {
      id: 'MEDIA1',
      caption: 'Foto',
    });
    assert.equal((t.calls[0]!.body as Record<string, unknown>).type, 'image');
    assert.deepEqual((t.calls[1]!.body as Record<string, unknown>).document, {
      link: 'https://cdn.exemplo.com/a.pdf',
      filename: 'a.pdf',
    });
  });

  it('valida combinações inválidas', async () => {
    const t = make([]);
    const to = '5511999990000';
    await assert.rejects(
      t.client.sendMedia({ to, kind: 'audio', media: { id: 'A' }, caption: 'x' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendMedia({ to, kind: 'image', media: { id: 'A' }, filename: 'x' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendMedia({ to, kind: 'image', media: { link: 'http://inseguro.com/a.jpg' } }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendMedia({ to, kind: 'image', media: {} as never }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.sendMedia({
        to,
        kind: 'image',
        media: { id: 'A', link: 'https://x.com/a.jpg' } as never,
      }),
      WhatsAppValidationError,
    );
    assert.equal(t.calls.length, 0);
  });
});

describe('WhatsAppClient — upload, download e exclusão de mídia', () => {
  it('sobe arquivo em multipart', async () => {
    const t = make([json({ id: 'MEDIA42' })]);
    const result = await t.client.uploadMedia({
      data: new Uint8Array([1, 2, 3]),
      mimeType: 'image/png',
      filename: 'a.png',
    });
    assert.deepEqual(result, { id: 'MEDIA42' });
    const call = t.calls[0]!;
    assert.equal(call.url, 'https://graph.facebook.com/v23.0/106540352242922/media');
    assert.equal(call.headers['Content-Type'], undefined); // o fetch coloca o boundary
    const form = call.rawBody as FormData;
    assert.equal(form.get('messaging_product'), 'whatsapp');
    const file = form.get('file') as File;
    assert.equal(file.type, 'image/png');
    assert.equal(file.name, 'a.png');
  });

  it('recusa tipo/tamanho fora dos limites antes de subir', async () => {
    const t = make([]);
    await assert.rejects(
      t.client.uploadMedia({ data: new Uint8Array(1), mimeType: 'image/gif' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.uploadMedia({ data: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: 'image/jpeg' }),
      WhatsAppValidationError,
    );
    await assert.rejects(
      t.client.uploadMedia({ data: new Uint8Array(0), mimeType: 'image/jpeg' }),
      WhatsAppValidationError,
    );
    assert.equal(t.calls.length, 0);
  });

  it('getMediaUrl devolve metadados', async () => {
    const t = make([
      json({
        id: 'M1',
        url: 'https://lookaside.example/m1',
        mime_type: 'image/jpeg',
        sha256: 'abc',
        file_size: '1234',
        messaging_product: 'whatsapp',
      }),
    ]);
    const meta = await t.client.getMediaUrl('M1');
    assert.deepEqual(meta, {
      id: 'M1',
      url: 'https://lookaside.example/m1',
      mimeType: 'image/jpeg',
      sha256: 'abc',
      fileSize: 1234,
    });
    assert.equal(t.calls[0]!.url, 'https://graph.facebook.com/v23.0/M1');
  });

  it('downloadMedia baixa com o token e confere o SHA-256', async () => {
    const data = Buffer.from('conteudo-da-imagem');
    const sha = createHash('sha256').update(data).digest('hex');
    const t = make([
      json({ id: 'M1', url: 'https://lookaside.example/m1', mime_type: 'image/jpeg', sha256: sha }),
      new Response(data, {
        headers: { 'content-type': 'image/jpeg', 'content-length': String(data.length) },
      }),
    ]);
    const media = await t.client.downloadMedia('M1');
    assert.equal(media.data.toString(), 'conteudo-da-imagem');
    assert.equal(media.mimeType, 'image/jpeg');
    assert.equal(t.calls[1]!.url, 'https://lookaside.example/m1');
    assert.equal(t.calls[1]!.headers.Authorization, `Bearer ${TOKEN}`);
  });

  it('downloadMedia falha se o SHA-256 não confere', async () => {
    const t = make([
      json({
        id: 'M1',
        url: 'https://lookaside.example/m1',
        mime_type: 'image/jpeg',
        sha256: 'f'.repeat(64),
      }),
      new Response('outro-conteudo'),
    ]);
    await assert.rejects(
      t.client.downloadMedia('M1'),
      (e: Error) => e.name === 'WhatsAppError' && /SHA-256/.test(e.message),
    );
  });

  it('downloadMedia pede nova URL uma vez quando a primeira dá 404', async () => {
    const data = Buffer.from('ok');
    const t = make([
      json({ id: 'M1', url: 'https://lookaside.example/velha', mime_type: 'image/jpeg' }),
      json({ error: { message: 'not found', code: 100 } }, 404),
      json({ id: 'M1', url: 'https://lookaside.example/nova', mime_type: 'image/jpeg' }),
      new Response(data),
    ]);
    const media = await t.client.downloadMedia('M1');
    assert.equal(media.data.toString(), 'ok');
    assert.equal(t.calls[3]!.url, 'https://lookaside.example/nova');
  });

  it('downloadMedia respeita o limite de tamanho', async () => {
    const t = make([
      json({ id: 'M1', url: 'https://lookaside.example/m1', mime_type: 'image/jpeg' }),
      new Response(Buffer.alloc(2048)),
    ]);
    await assert.rejects(t.client.downloadMedia('M1', { maxBytes: 1024 }), (e: Error) =>
      /limite/.test(e.message),
    );
  });

  it('downloadMedia não envia o token para URL que não seja HTTPS', async () => {
    const t = make([
      json({ id: 'M1', url: 'http://malicioso.example/m1', mime_type: 'image/jpeg' }),
    ]);
    await assert.rejects(t.client.downloadMedia('M1'), WhatsAppValidationError);
    assert.equal(t.calls.length, 1); // só a consulta de metadados; nada foi baixado
  });

  it('deleteMedia e markAsRead', async () => {
    const t = make([json({ success: true }), json({ success: true })]);
    await t.client.deleteMedia('M1');
    await t.client.markAsRead('wamid.IN');
    assert.equal(t.calls[0]!.method, 'DELETE');
    assert.deepEqual(t.calls[1]!.body, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.IN',
    });
  });
});

describe('WhatsAppClient — erros', () => {
  it('traduz erro da Meta em WhatsAppApiError tipado (janela de 24h)', async () => {
    const t = make([
      json(
        {
          error: {
            message: 'Re-engagement message',
            type: 'OAuthException',
            code: 131047,
            error_data: { details: 'Mais de 24h' },
            fbtrace_id: 'TRACE1',
          },
        },
        400,
      ),
    ]);
    await assert.rejects(t.client.sendText({ to: '5511999990000', body: 'oi' }), (e: unknown) => {
      assert.ok(e instanceof WhatsAppApiError);
      assert.equal(e.code, 131047);
      assert.equal(e.category, 'window_expired');
      assert.equal(e.retryable, false);
      assert.equal(e.fbtraceId, 'TRACE1');
      return true;
    });
  });

  it('rate limit é repetível', async () => {
    const t = make([json({ error: { message: 'Rate limit', code: 130429 } }, 429)]);
    await assert.rejects(
      t.client.sendText({ to: '5511999990000', body: 'oi' }),
      (e: unknown) => e instanceof WhatsAppApiError && e.retryable && e.category === 'rate_limit',
    );
  });

  it('resposta 502 em HTML vira erro temporário', async () => {
    const t = make([new Response('<html>Bad gateway</html>', { status: 502 })]);
    await assert.rejects(
      t.client.sendText({ to: '5511999990000', body: 'oi' }),
      (e: unknown) => e instanceof WhatsAppApiError && e.category === 'temporary' && e.retryable,
    );
  });

  it('falha de rede e timeout viram WhatsAppNetworkError repetível', async () => {
    const down = make(() => {
      throw new TypeError('fetch failed');
    });
    await assert.rejects(
      down.client.sendText({ to: '5511999990000', body: 'oi' }),
      (e: unknown) => e instanceof WhatsAppNetworkError && e.retryable && !e.timedOut,
    );

    // O timer de AbortSignal.timeout NÃO mantém o Node vivo (no fetch real, o socket mantém);
    // por isso seguramos o processo com um timer próprio até a requisição ser abortada.
    const respectingFetch = (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 10_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      })) as typeof fetch;
    const client = new WhatsAppClient({
      accessToken: 't',
      phoneNumberId: '1',
      tenantId: 'x',
      fetch: respectingFetch,
      timeoutMs: 20,
    });
    await assert.rejects(
      client.sendText({ to: '5511999990000', body: 'oi' }),
      (e: unknown) => e instanceof WhatsAppNetworkError && e.timedOut,
    );
  });

  it('resposta de sucesso fora do formato vira erro não repetível', async () => {
    const t = make([json({ algo: 'inesperado' })]);
    await assert.rejects(
      t.client.sendText({ to: '5511999990000', body: 'oi' }),
      (e: unknown) => e instanceof Error && e.name === 'WhatsAppError' && /formato/.test(e.message),
    );
  });
});

describe('WhatsAppClient — logs e métricas (rastreabilidade por tenant)', () => {
  it('sucesso: log info com tenant_id, sem token, sem texto e com telefone mascarado', async () => {
    const t = make([json(OK_SEND)]);
    await t.client.sendText({ to: '5511999990000', body: 'segredo do cliente' });

    const log = t.lines.find((l) => l.fields.event === 'whatsapp.request')!;
    assert.equal(log.level, 'info');
    assert.equal(log.fields.tenant_id, 'tenant-1');
    assert.equal(log.fields.phone_number_id, '106540352242922');
    assert.equal(log.fields.operation, 'send_text');
    assert.equal(log.fields.outcome, 'success');
    assert.equal(log.fields.message_id, 'wamid.OUT1');
    assert.equal(log.fields.to_suffix, '***0000');
    assert.equal(typeof log.fields.duration_ms, 'number');

    const serialized = JSON.stringify(t.lines);
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('segredo do cliente'), false);
    assert.equal(serialized.includes('5511999990000'), false);

    assert.deepEqual(t.counters[0], {
      name: 'whatsapp_api_requests_total',
      labels: { tenant_id: 'tenant-1', operation: 'send_text', outcome: 'success' },
      value: 1,
    });
    assert.equal(t.timings[0]!.name, 'whatsapp_api_request_duration_ms');
    assert.equal(t.timings[0]!.labels?.tenant_id, 'tenant-1');
  });

  it('erro: nível warn se repetível, error se não; inclui código e categoria', async () => {
    const t = make([
      json({ error: { message: 'x', code: 131047, fbtrace_id: 'T' } }, 400),
      json({ error: { message: 'y', code: 130429 } }, 429),
    ]);
    await assert.rejects(t.client.sendText({ to: '5511999990000', body: 'a' }));
    await assert.rejects(t.client.sendText({ to: '5511999990000', body: 'b' }));

    assert.equal(t.lines[0]!.level, 'error');
    assert.equal(t.lines[0]!.fields.error_code, 131047);
    assert.equal(t.lines[0]!.fields.error_category, 'window_expired');
    assert.equal(t.lines[0]!.fields.tenant_id, 'tenant-1');
    assert.equal(t.lines[1]!.level, 'warn');
    assert.equal(t.lines[1]!.fields.retryable, true);
    assert.deepEqual(t.counters[0]!.labels, {
      tenant_id: 'tenant-1',
      operation: 'send_text',
      outcome: 'error',
      error_category: 'window_expired',
    });
  });
});
