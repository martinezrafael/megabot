import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { AiError, FakeEmbeddingProvider, type EmbeddingProvider } from '@megabot/ai';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS as DIMS,
  createKnowledgeSource,
  getKnowledgeSource,
  listKnowledgeChunks,
  searchKnowledgeChunks,
  updateKnowledgeChunkContent,
} from '@megabot/database';
import { KnowledgeError, type RemoteDocument } from '@megabot/knowledge';
import { LocalObjectStorage, buildKnowledgeObjectKey } from '@megabot/storage';
import { createIngestKnowledgeHandler } from '../src/handlers/ingest-knowledge';
import { captureLogger, cleanupTenants, newTenant, runJob } from './helpers';

const FIXTURES = join(__dirname, '..', '..', '..', 'packages', 'knowledge', 'tests', 'fixtures');
const PDF = new Uint8Array(readFileSync(join(FIXTURES, 'politica.pdf')));
const XLSX = new Uint8Array(readFileSync(join(FIXTURES, 'catalogo.xlsx')));
const SCANNED = new Uint8Array(readFileSync(join(FIXTURES, 'escaneado.pdf')));
const encode = (text: string) => new TextEncoder().encode(text);

describe('job knowledge.ingest (T2.2) — Postgres, pgvector e storage reais', () => {
  let tenantId = '';
  let dir = '';
  let storage: LocalObjectStorage;
  const embedder = new FakeEmbeddingProvider(DIMS);

  const handler = (over: Partial<Parameters<typeof createIngestKnowledgeHandler>[0]> = {}) =>
    createIngestKnowledgeHandler({ storage, embedder, ...over });

  const ingest = (
    sourceId: string,
    options: {
      mode?: 'full' | 'stale';
      deps?: Partial<Parameters<typeof createIngestKnowledgeHandler>[0]>;
      attempt?: number;
      maxAttempts?: number;
    } = {},
  ) =>
    runJob(
      handler(options.deps),
      tenantId,
      { tenantId, sourceId, mode: options.mode ?? 'full' },
      {
        ...(options.attempt ? { attempt: options.attempt } : {}),
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      },
    );

  async function uploadSource(fileName: string, bytes: Uint8Array, mimeType: string) {
    const sourceId = randomUUID();
    const storageKey = buildKnowledgeObjectKey({ tenantId, sourceId, fileName });
    await storage.put(storageKey, bytes, { contentType: mimeType });
    return createKnowledgeSource(tenantId, {
      id: sourceId,
      kind: 'upload',
      title: fileName,
      storageKey,
      fileName,
      mimeType,
      byteSize: bytes.byteLength,
    });
  }

  before(async () => {
    ({ tenantId } = await newTenant({ whatsapp: false }));
    dir = await mkdtemp(join(tmpdir(), 'megabot-ingest-'));
    storage = new LocalObjectStorage(dir);
  });

  after(async () => {
    await cleanupTenants();
    await rm(dir, { recursive: true, force: true });
  });

  it('PDF enviado: extrai, divide, embedda e deixa a fonte pronta e pesquisável', async () => {
    const source = await uploadSource('politica.pdf', PDF, 'application/pdf');
    const { promise, logs } = ingest(source.id);
    await promise;

    const ready = await getKnowledgeSource(tenantId, source.id);
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.progress, 100);
    assert.ok((ready?.chunkCount ?? 0) >= 1);
    assert.ok((ready?.charCount ?? 0) > 100);
    assert.equal(ready?.embeddingDimensions, DIMS);
    assert.equal(ready?.embeddingModel, 'fake');
    assert.equal(ready?.errorCode, null);
    assert.ok(ready?.lastIngestedAt instanceof Date);
    assert.ok(ready?.checksum && ready.checksum.length === 64);

    const chunks = await listKnowledgeChunks(tenantId, source.id);
    assert.ok(chunks.every((c) => c.hasEmbedding && !c.embeddingStale));
    assert.match(chunks[0]!.content, /trocas e devoluções/i);
    assert.equal(chunks[0]!.heading, 'Página 1');

    // Pesquisável de verdade: busca pelo embedding do próprio trecho encontra o trecho.
    const { embeddings } = await embedder.embed({ tenantId, input: [chunks[0]!.content] });
    const hits = await searchKnowledgeChunks(tenantId, embeddings[0]!, { limit: 3 });
    assert.equal(hits[0]?.chunkId, chunks[0]!.id);
    assert.ok(hits[0]!.similarity > 0.99);

    // Log do fim, com tenant_id e sem conteúdo do documento.
    const finished = logs.find((l) => l.event === 'knowledge.ingest.finished');
    assert.ok(finished);
    assert.equal(finished.tenant_id, tenantId);
    assert.equal(finished.embedding_model, 'fake');
    assert.ok(!JSON.stringify(logs).includes('trocas e devoluções'));
    assert.ok(
      logs.some(
        (l) =>
          l.metric === 'knowledge_ingest_total' &&
          l.outcome === 'ready' &&
          l.tenant_id === tenantId,
      ),
    );
    assert.ok(logs.some((l) => l.metric === 'knowledge_chunks_total'));
  });

  it('planilha enviada: cada aba virando seção', async () => {
    const source = await uploadSource(
      'catalogo.xlsx',
      XLSX,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    await ingest(source.id).promise;
    const chunks = await listKnowledgeChunks(tenantId, source.id);
    assert.ok(chunks.length >= 1);
    assert.ok(chunks.some((c) => c.heading === 'Aba: Produtos'));
    assert.match(chunks.map((c) => c.content).join('\n'), /Camiseta preta/);
  });

  it('texto colado: vira trechos sem passar por storage nem rede', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Horários',
      rawText: '# Atendimento\n\nDe segunda a sexta, das 9h às 18h.\n\nSábado até as 13h.',
    });
    await ingest(source.id).promise;
    const chunks = await listKnowledgeChunks(tenantId, source.id);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0]?.heading, 'Atendimento');
    assert.match(chunks[0]!.content, /9h às 18h/);
    assert.equal((await getKnowledgeSource(tenantId, source.id))?.status, 'ready');
  });

  it('URL: baixa (fetch injetado), extrai o HTML e indexa', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'url',
      title: 'site',
      sourceUrl: 'https://loja.exemplo.com.br/trocas',
    });
    const fetched: string[] = [];
    const fetchDocument = async (url: string): Promise<RemoteDocument> => {
      fetched.push(url);
      return {
        bytes: encode(
          '<html><head><title>Trocas</title></head><body><h2>Trocas</h2><p>Em até 30 dias corridos.</p></body></html>',
        ),
        mimeType: 'text/html',
        charset: 'utf-8',
        format: 'html',
        finalUrl: url,
        fileName: null,
      };
    };
    await ingest(source.id, { deps: { fetchDocument } }).promise;

    assert.deepEqual(fetched, ['https://loja.exemplo.com.br/trocas']);
    const chunks = await listKnowledgeChunks(tenantId, source.id);
    assert.equal(chunks[0]?.heading, 'Trocas');
    assert.match(chunks[0]!.content, /30 dias corridos/);
  });

  it('reingestão troca os trechos e é idempotente', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Idempotência',
      rawText: 'Primeira versão do texto.',
    });
    await ingest(source.id).promise;
    const first = await listKnowledgeChunks(tenantId, source.id);

    await ingest(source.id).promise;
    const second = await listKnowledgeChunks(tenantId, source.id);
    assert.deepEqual(
      second.map((c) => [c.position, c.content]),
      first.map((c) => [c.position, c.content]),
    );
    assert.equal((await getKnowledgeSource(tenantId, source.id))?.chunkCount, second.length);
  });

  it('PDF escaneado: falha definitiva com explicação sobre OCR', async () => {
    const source = await uploadSource('escaneado.pdf', SCANNED, 'application/pdf');
    const { promise, logs } = ingest(source.id);
    await assert.rejects(promise, (error: unknown) => {
      assert.equal((error as { retryable?: boolean }).retryable, false);
      assert.match((error as Error).message, /escaneado/);
      return true;
    });

    const failed = await getKnowledgeSource(tenantId, source.id);
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.errorCode, 'sem_texto');
    assert.match(failed?.errorMessage ?? '', /escaneado|texto selecionável/);
    assert.ok(logs.some((l) => l.event === 'knowledge.ingest.failed' && l.tenant_id === tenantId));
  });

  it('arquivo que sumiu do storage: falha definitiva pedindo novo envio', async () => {
    const source = await uploadSource('sumido.txt', encode('conteúdo'), 'text/plain');
    await storage.delete(source.storageKey!);
    await assert.rejects(ingest(source.id).promise, /envie o arquivo de novo/i);
    const failed = await getKnowledgeSource(tenantId, source.id);
    assert.equal(failed?.errorCode, 'arquivo_ausente');
    assert.equal(failed?.status, 'failed');
  });

  it('URL bloqueada/inacessível: mensagem do erro vai para a tela', async () => {
    const blocked = await createKnowledgeSource(tenantId, {
      kind: 'url',
      title: 'interno',
      sourceUrl: 'http://169.254.169.254/latest/meta-data',
    });
    const fetchDocument = async (): Promise<RemoteDocument> => {
      throw new KnowledgeError(
        'url_bloqueada',
        'Esse endereço aponta para a rede interna do servidor.',
      );
    };
    await assert.rejects(ingest(blocked.id, { deps: { fetchDocument } }).promise, /rede interna/);
    const failed = await getKnowledgeSource(tenantId, blocked.id);
    assert.equal(failed?.errorCode, 'url_bloqueada');
    assert.match(failed?.errorMessage ?? '', /rede interna/);
  });

  it('erro passageiro: só registra a falha na ÚLTIMA tentativa (a tela segue "processando")', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'url',
      title: 'site instável',
      sourceUrl: 'https://instavel.exemplo.com',
    });
    const fetchDocument = async (): Promise<RemoteDocument> => {
      throw new KnowledgeError(
        'url_erro_http',
        'O site respondeu 503. Vamos tentar de novo.',
        true,
      );
    };

    const first = ingest(source.id, { deps: { fetchDocument }, attempt: 1, maxAttempts: 3 });
    await assert.rejects(first.promise, /503/);
    const during = await getKnowledgeSource(tenantId, source.id);
    assert.equal(during?.status, 'processing', 'erro repetível não marca falha no meio do caminho');
    assert.equal(during?.errorCode, null);
    assert.ok(
      first.logs.some((l) => l.metric === 'knowledge_ingest_total' && l.outcome === 'retrying'),
    );

    const last = ingest(source.id, { deps: { fetchDocument }, attempt: 3, maxAttempts: 3 });
    await assert.rejects(last.promise, /503/);
    const after = await getKnowledgeSource(tenantId, source.id);
    assert.equal(after?.status, 'failed');
    assert.equal(after?.errorCode, 'url_erro_http');
  });

  it('erros da IA: cota/chave são definitivos, limite de taxa é repetível', async () => {
    const failing = (error: AiError): EmbeddingProvider => ({
      name: 'fake-falho',
      embed: async () => {
        throw error;
      },
    });

    const quota = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'sem cota',
      rawText: 'texto qualquer',
    });
    await assert.rejects(
      ingest(quota.id, {
        deps: {
          embedder: failing(new AiError('sem saldo', { category: 'quota', retryable: false })),
        },
      }).promise,
      (error: unknown) => {
        assert.equal((error as { retryable?: boolean }).retryable, false);
        return true;
      },
    );
    const quotaSource = await getKnowledgeSource(tenantId, quota.id);
    assert.equal(quotaSource?.errorCode, 'ia_quota');
    assert.match(quotaSource?.errorMessage ?? '', /saldo|cota/);

    const rate = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'limite de taxa',
      rawText: 'texto qualquer',
    });
    await assert.rejects(
      ingest(rate.id, {
        deps: {
          embedder: failing(new AiError('429', { category: 'rate_limit', retryable: true })),
        },
        attempt: 2,
        maxAttempts: 2,
      }).promise,
      AiError,
    );
    const rateSource = await getKnowledgeSource(tenantId, rate.id);
    assert.equal(rateSource?.errorCode, 'ia_rate_limit');
    assert.match(rateSource?.errorMessage ?? '', /limitando/);
  });

  it('documento grande: embedda em vários lotes e o progresso avança', async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, i) => `Parágrafo ${i}: ${'conteúdo de teste '.repeat(20)}`,
    );
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Documento grande',
      rawText: paragraphs.join('\n\n'),
    });

    const batches: number[] = [];
    const counting: EmbeddingProvider = {
      name: 'fake-contado',
      embed: async (request) => {
        batches.push(request.input.length);
        return embedder.embed(request);
      },
    };
    await ingest(source.id, { deps: { embedder: counting, embedBatchSize: 4 } }).promise;

    assert.ok(batches.length >= 3, `esperava vários lotes, veio ${batches.length}`);
    assert.ok(batches.every((size) => size <= 4));
    const ready = await getKnowledgeSource(tenantId, source.id);
    assert.equal(ready?.status, 'ready');
    assert.equal(
      ready?.chunkCount,
      batches.reduce((sum, size) => sum + size, 0),
    );
  });

  it('modo stale: recalcula só o trecho editado, sem mexer no texto nem nos outros', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Edição manual',
      rawText: '# A\n\nPrimeiro bloco de texto.\n\n# B\n\nSegundo bloco de texto.',
    });
    await ingest(source.id).promise;
    const before = await listKnowledgeChunks(tenantId, source.id);
    assert.equal(before.length, 2);

    await updateKnowledgeChunkContent(tenantId, before[0]!.id, 'Texto que o cliente corrigiu.');
    const { promise, logs } = ingest(source.id, { mode: 'stale' });
    await promise;

    const after = await listKnowledgeChunks(tenantId, source.id);
    assert.equal(after[0]?.content, 'Texto que o cliente corrigiu.');
    assert.equal(after[0]?.embeddingStale, false, 'embedding recalculado');
    assert.equal(after[0]?.edited, true, 'continua marcado como editado');
    assert.equal(after[1]?.content, before[1]?.content);
    // A fonte não é reprocessada: segue pronta, com o mesmo número de trechos.
    const unchanged = await getKnowledgeSource(tenantId, source.id);
    assert.equal(unchanged?.status, 'ready');
    assert.equal(unchanged?.chunkCount, 2);
    assert.ok(logs.some((l) => l.event === 'knowledge.reembed.finished' && l.chunk_count === 1));

    // E a busca agora encontra o texto novo.
    const { embeddings } = await embedder.embed({
      tenantId,
      input: ['Texto que o cliente corrigiu.'],
    });
    const hits = await searchKnowledgeChunks(tenantId, embeddings[0]!, { limit: 1 });
    assert.equal(hits[0]?.chunkId, before[0]!.id);
  });

  it('modo stale sem nada pendente não faz nada', async () => {
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Nada pendente',
      rawText: 'texto',
    });
    await ingest(source.id).promise;
    const calls: number[] = [];
    await ingest(source.id, {
      mode: 'stale',
      deps: {
        embedder: {
          name: 'nao-deveria-ser-chamado',
          embed: async (request) => {
            calls.push(request.input.length);
            return embedder.embed(request);
          },
        },
      },
    }).promise;
    assert.deepEqual(calls, []);
  });

  it('fonte apagada antes do job: ignora sem falhar', async () => {
    const { promise, logs } = ingest(randomUUID());
    await promise;
    assert.ok(logs.some((l) => l.event === 'knowledge.ingest.skipped'));
  });

  it('nenhum log traz o conteúdo do documento', async () => {
    const segredo = 'DADO-SIGILOSO-DO-CLIENTE-123';
    const source = await createKnowledgeSource(tenantId, {
      kind: 'text',
      title: 'Sigiloso',
      rawText: `# Seção\n\n${segredo}`,
    });
    const cap = captureLogger();
    await runJob(
      createIngestKnowledgeHandler({ storage, embedder }),
      tenantId,
      { tenantId, sourceId: source.id, mode: 'full' },
      { logger: cap },
    ).promise;
    assert.ok(!JSON.stringify(cap.logs).includes(segredo));
    assert.ok(cap.logs.some((l) => l.event === 'knowledge.ingest.finished'));
  });
});
