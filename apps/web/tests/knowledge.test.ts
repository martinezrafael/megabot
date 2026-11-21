import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  fetchKnowledgeChunks,
  fetchKnowledgeLimits,
  fetchKnowledgeSource,
  fetchKnowledgeSources,
  type KnowledgeSource,
} from '../src/lib/knowledge';
import {
  formatBytes,
  formatDateTime,
  formatNumber,
  hasWorkInProgress,
  kindLabel,
  sourceSummary,
  statusClass,
  statusLabel,
} from '../src/lib/knowledge-format';

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'upload',
    title: 'Política.pdf',
    status: 'ready',
    progress: 100,
    sourceUrl: null,
    fileName: 'politica.pdf',
    mimeType: 'application/pdf',
    byteSize: 2048,
    charCount: 500,
    chunkCount: 3,
    embeddingModel: 'modelo-emb',
    lastIngestedAt: '2026-11-21T12:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-11-21T11:00:00.000Z',
    updatedAt: '2026-11-21T12:00:00.000Z',
    ...over,
  }) as KnowledgeSource;

/** fetch de mentira: devolve o que o teste pedir e guarda a chamada. */
function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const options = (fetchImpl: typeof fetch) => ({
  apiUrl: 'http://api.test',
  cookie: 'session=abc',
  forwardedFor: '203.0.113.9',
  requestId: 'req-1',
  fetchImpl,
});

describe('busca das fontes (Server Components)', () => {
  it('chama a API repassando cookie, IP e request id', async () => {
    const { fetchImpl, calls } = fakeFetch(200, [source()]);
    const result = await fetchKnowledgeSources(options(fetchImpl));
    assert.equal(result.status, 'ok');
    assert.equal(calls[0]!.url, 'http://api.test/knowledge/sources');
    assert.equal(calls[0]!.headers.cookie, 'session=abc');
    assert.equal(calls[0]!.headers['x-forwarded-for'], '203.0.113.9');
    assert.equal(calls[0]!.headers['x-request-id'], 'req-1');
  });

  it('monta as URLs de detalhe, trechos (com paginação) e limites', async () => {
    const { fetchImpl, calls } = fakeFetch(200, {});
    const o = options(fetchImpl);
    await fetchKnowledgeSource(o, 'abc 1');
    await fetchKnowledgeChunks(o, 'abc', { limit: 10, offset: 20 });
    await fetchKnowledgeChunks(o, 'abc');
    await fetchKnowledgeLimits(o);
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        'http://api.test/knowledge/sources/abc%201',
        'http://api.test/knowledge/sources/abc/chunks?limit=10&offset=20',
        'http://api.test/knowledge/sources/abc/chunks?limit=50&offset=0',
        'http://api.test/knowledge/limits',
      ],
    );
  });

  it('401/403 viram "forbidden", 404 vira "not_found" e erro inesperado estoura', async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = fakeFetch(status, {});
      assert.equal((await fetchKnowledgeSources(options(fetchImpl))).status, 'forbidden');
    }
    const notFound = fakeFetch(404, {});
    assert.equal(
      (await fetchKnowledgeSource(options(notFound.fetchImpl), 'x')).status,
      'not_found',
    );
    const broken = fakeFetch(500, {});
    await assert.rejects(fetchKnowledgeSources(options(broken.fetchImpl)), /500/);
  });
});

describe('formatação da tela', () => {
  it('rótulos de situação e tipo', () => {
    assert.equal(statusLabel('ready'), 'Pronta');
    assert.equal(statusLabel('processing'), 'Processando');
    assert.equal(statusLabel('inventado'), 'inventado');
    assert.equal(statusClass('ready'), 'status status-ok');
    assert.equal(statusClass('failed'), 'status status-danger');
    assert.equal(statusClass('inventado'), 'status');
    assert.equal(kindLabel('url'), 'Site');
    assert.equal(kindLabel('upload'), 'Arquivo');
  });

  it('resumo de cada linha explica o estado em uma frase', () => {
    assert.equal(sourceSummary(source({ chunkCount: 3 })), '3 trechos indexados.');
    assert.equal(sourceSummary(source({ chunkCount: 1 })), '1 trecho indexado.');
    assert.equal(
      sourceSummary(source({ status: 'pending' })),
      'Aguardando o processamento começar.',
    );
    assert.equal(sourceSummary(source({ status: 'processing', progress: 40 })), 'Processando… 40%');
    assert.equal(
      sourceSummary(
        source({ status: 'failed', errorCode: 'sem_texto', errorMessage: 'PDF escaneado.' }),
      ),
      'PDF escaneado.',
    );
  });

  it('tamanhos, números e datas', () => {
    assert.equal(formatBytes(900), '900 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(formatBytes(null), '—');
    assert.equal(formatNumber(1500), (1500).toLocaleString('pt-BR'));
    assert.equal(formatNumber(null), '—');
    assert.equal(formatDateTime(null), '—');
    assert.equal(formatDateTime('nao-e-data'), '—');
    assert.ok(formatDateTime('2026-11-21T12:00:00.000Z').includes('21/11/2026'));
  });

  it('atualiza sozinha só quando há algo em andamento', () => {
    assert.equal(hasWorkInProgress([source(), source({ status: 'failed' })]), false);
    assert.equal(hasWorkInProgress([source({ status: 'pending' })]), true);
    assert.equal(hasWorkInProgress([source({ status: 'processing' })]), true);
    assert.equal(hasWorkInProgress([]), false);
  });
});
