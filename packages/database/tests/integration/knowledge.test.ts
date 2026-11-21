import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  EmbeddingDimensionsError,
  KNOWLEDGE_EMBEDDING_DIMENSIONS as DIMS,
  KnowledgeChunkNotFoundError,
  KnowledgeSourceNotFoundError,
  claimKnowledgeSourceForIngestion,
  countKnowledgeChunks,
  createKnowledgeSource,
  deleteKnowledgeChunk,
  deleteKnowledgeSource,
  finishKnowledgeSourceIngestion,
  getKnowledgeSource,
  getKnowledgeSourceForIngestion,
  listKnowledgeChunks,
  listKnowledgeSources,
  listStaleKnowledgeChunks,
  markKnowledgeSourceFailed,
  replaceKnowledgeChunks,
  searchKnowledgeChunks,
  setKnowledgeChunkEmbeddings,
  setKnowledgeSourceProgress,
  updateKnowledgeChunkContent,
} from '../../src';

const run = randomUUID().slice(0, 8);
const MODEL = 'modelo-emb-teste';

/** Vetor unitário "apontando" para uma direção: vetores de seeds diferentes são pouco parecidos. */
function vector(seed: number, dimensions = DIMS): number[] {
  const raw = Array.from({ length: dimensions }, (_, i) => Math.sin((i + 1) * (seed + 1)));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

const chunk = (position: number, content: string, seed: number, heading?: string) => ({
  position,
  content,
  embedding: vector(seed),
  ...(heading ? { heading } : {}),
});

describe('base de conhecimento (Postgres + pgvector reais)', () => {
  let tenantA = '';
  let tenantB = '';

  before(async () => {
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: 'KB A', slug: `kb-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'KB B', slug: `kb-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('a extensão vector e o índice HNSW existem', async () => {
    const [ext] = await prisma.$queryRaw<Array<{ extversion: string }>>`
      SELECT extversion FROM pg_extension WHERE extname = 'vector'`;
    assert.ok(ext, 'extensão vector não instalada');
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'knowledge_chunks'`;
    assert.ok(
      indexes.some((i) => /USING hnsw/i.test(i.indexdef)),
      'índice HNSW ausente',
    );
  });

  it('cria fontes dos três tipos e lista da mais nova para a mais antiga', async () => {
    const text = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Texto colado',
      rawText: 'conteúdo',
    });
    const url = await createKnowledgeSource(tenantA, {
      kind: 'url',
      title: 'Site da empresa',
      sourceUrl: 'https://exemplo.com.br/sobre',
    });
    const upload = await createKnowledgeSource(tenantA, {
      kind: 'upload',
      title: 'Catálogo.pdf',
      storageKey: `tenants/${tenantA}/catalogo.pdf`,
      fileName: 'catalogo.pdf',
      mimeType: 'application/pdf',
      byteSize: 2048,
    });

    assert.equal(text.status, 'pending');
    assert.equal(text.progress, 0);
    assert.equal(text.chunkCount, 0);
    assert.equal(url.sourceUrl, 'https://exemplo.com.br/sobre');
    assert.equal(upload.mimeType, 'application/pdf');
    // O texto colado não volta na listagem (só o worker o pede).
    assert.ok(!('rawText' in text));

    const list = await listKnowledgeSources(tenantA);
    assert.deepEqual(
      list.slice(0, 3).map((s) => s.id),
      [upload.id, url.id, text.id],
    );
    assert.equal((await getKnowledgeSourceForIngestion(tenantA, text.id))?.rawText, 'conteúdo');
  });

  it('o banco recusa fonte sem origem, título vazio, status ou progresso inválidos', async () => {
    await assert.rejects(
      withTenant(tenantA, (tx) =>
        tx.knowledgeSource.create({ data: { tenantId: tenantA, kind: 'url', title: 'Sem URL' } }),
      ),
      /knowledge_sources_origin_check/,
    );
    await assert.rejects(
      createKnowledgeSource(tenantA, { kind: 'text', title: '   ', rawText: 'x' }),
      /title é obrigatório/,
    );
    const ok = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Para checks',
      rawText: 'x',
    });
    await assert.rejects(
      withTenant(tenantA, (tx) =>
        tx.knowledgeSource.updateMany({ where: { id: ok.id }, data: { status: 'inventado' } }),
      ),
      /knowledge_sources_status_check/,
    );
    await assert.rejects(
      withTenant(tenantA, (tx) =>
        tx.knowledgeSource.updateMany({ where: { id: ok.id }, data: { progress: 101 } }),
      ),
      /knowledge_sources_progress_check/,
    );
    // status failed exige código de erro, e vice-versa.
    await assert.rejects(
      withTenant(tenantA, (tx) =>
        tx.knowledgeSource.updateMany({ where: { id: ok.id }, data: { status: 'failed' } }),
      ),
      /knowledge_sources_error_check/,
    );
  });

  it('ciclo de vida: claim, progresso, trechos, pronto', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Política de trocas',
      rawText: 'texto original',
    });
    await markKnowledgeSourceFailed(tenantA, source.id, { code: 'erro_antigo', message: 'falhou' });

    const claimed = await claimKnowledgeSourceForIngestion(tenantA, source.id);
    assert.equal(claimed.status, 'processing');
    assert.equal(claimed.errorCode, null, 'o claim limpa o erro anterior');
    assert.equal(claimed.rawText, 'texto original');

    await setKnowledgeSourceProgress(tenantA, source.id, 55.6);
    assert.equal((await getKnowledgeSource(tenantA, source.id))?.progress, 56);
    await setKnowledgeSourceProgress(tenantA, source.id, 999);
    assert.equal((await getKnowledgeSource(tenantA, source.id))?.progress, 100);

    const { inserted } = await replaceKnowledgeChunks(
      tenantA,
      source.id,
      [chunk(0, 'Trocas em até 30 dias.', 1, 'Trocas'), chunk(1, 'Frete por conta da loja.', 2)],
      MODEL,
    );
    assert.equal(inserted, 2);
    await finishKnowledgeSourceIngestion(tenantA, source.id, {
      checksum: 'abc123',
      charCount: 44,
      chunkCount: 2,
      embeddingModel: MODEL,
      embeddingDimensions: DIMS,
    });

    const ready = await getKnowledgeSource(tenantA, source.id);
    assert.equal(ready?.status, 'ready');
    assert.equal(ready?.progress, 100);
    assert.equal(ready?.chunkCount, 2);
    assert.equal(ready?.embeddingModel, MODEL);
    assert.equal(ready?.embeddingDimensions, DIMS);
    assert.ok(ready?.lastIngestedAt instanceof Date);

    const chunks = await listKnowledgeChunks(tenantA, source.id);
    assert.deepEqual(
      chunks.map((c) => [c.position, c.hasEmbedding, c.embeddingStale, c.edited]),
      [
        [0, true, false, false],
        [1, true, false, false],
      ],
    );
    assert.equal(chunks[0]?.heading, 'Trocas');
    assert.equal(chunks[0]?.charCount, 'Trocas em até 30 dias.'.length);
    // O vetor em si nunca sai do banco por estas funções.
    assert.ok(!('embedding' in (chunks[0] as object)));
  });

  it('reingestão troca os trechos inteiros, numa transação', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Reingestão',
      rawText: 'x',
    });
    await replaceKnowledgeChunks(
      tenantA,
      source.id,
      [chunk(0, 'antigo A', 1), chunk(1, 'antigo B', 2), chunk(2, 'antigo C', 3)],
      MODEL,
    );
    await replaceKnowledgeChunks(tenantA, source.id, [chunk(0, 'novo único', 4)], MODEL);
    const chunks = await listKnowledgeChunks(tenantA, source.id);
    assert.deepEqual(
      chunks.map((c) => c.content),
      ['novo único'],
    );

    // Vetor com dimensão errada: nada é apagado (a validação roda antes do DELETE).
    await assert.rejects(
      replaceKnowledgeChunks(
        tenantA,
        source.id,
        [{ position: 0, content: 'ruim', embedding: vector(1, 8) }],
        MODEL,
      ),
      EmbeddingDimensionsError,
    );
    assert.equal(await countKnowledgeChunks(tenantA, source.id), 1);
    assert.deepEqual(
      (await listKnowledgeChunks(tenantA, source.id)).map((c) => c.content),
      ['novo único'],
    );

    await assert.rejects(
      replaceKnowledgeChunks(tenantA, randomUUID(), [chunk(0, 'x', 1)], MODEL),
      KnowledgeSourceNotFoundError,
    );
  });

  it('insere muitos trechos (mais de um lote) mantendo a ordem', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Lote grande',
      rawText: 'x',
    });
    const many = Array.from({ length: 250 }, (_, i) => chunk(i, `trecho número ${i}`, i));
    const { inserted } = await replaceKnowledgeChunks(tenantA, source.id, many, MODEL);
    assert.equal(inserted, 250);
    assert.equal(await countKnowledgeChunks(tenantA, source.id), 250);
    const page = await listKnowledgeChunks(tenantA, source.id, { limit: 3, offset: 100 });
    assert.deepEqual(
      page.map((c) => c.position),
      [100, 101, 102],
    );
  });

  it('edição manual marca o trecho como editado e o embedding como desatualizado', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Edição',
      rawText: 'x',
    });
    await replaceKnowledgeChunks(
      tenantA,
      source.id,
      [chunk(0, 'conteúdo original', 1), chunk(1, 'outro', 2)],
      MODEL,
    );
    const [first] = await listKnowledgeChunks(tenantA, source.id);

    const edited = await updateKnowledgeChunkContent(tenantA, first!.id, '  texto corrigido  ');
    assert.equal(edited.content, 'texto corrigido');
    assert.equal(edited.charCount, 'texto corrigido'.length);
    assert.equal(edited.edited, true);
    assert.equal(edited.embeddingStale, true);
    assert.equal(edited.hasEmbedding, true, 'o embedding antigo continua lá até o reembedding');

    const stale = await listStaleKnowledgeChunks(tenantA, source.id);
    assert.deepEqual(
      stale.map((c) => c.id),
      [first!.id],
    );

    const changed = await setKnowledgeChunkEmbeddings(
      tenantA,
      [{ id: first!.id, embedding: vector(9) }],
      'modelo-novo',
    );
    assert.equal(changed, 1);
    const after = await listKnowledgeChunks(tenantA, source.id);
    assert.equal(after[0]?.embeddingStale, false);
    assert.equal(after[0]?.embeddingModel, 'modelo-novo');
    assert.equal(after[0]?.edited, true, 'continua marcado como editado');
    assert.equal((await listStaleKnowledgeChunks(tenantA, source.id)).length, 0);

    await assert.rejects(
      updateKnowledgeChunkContent(tenantA, first!.id, '   '),
      /não pode ficar vazio/,
    );
    await assert.rejects(
      updateKnowledgeChunkContent(tenantA, randomUUID(), 'x'),
      KnowledgeChunkNotFoundError,
    );
  });

  it('apagar trecho acerta o contador da fonte; apagar fonte leva os trechos e devolve a chave', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'upload',
      title: 'Arquivo.pdf',
      storageKey: `tenants/${tenantA}/arquivo.pdf`,
      fileName: 'arquivo.pdf',
      mimeType: 'application/pdf',
      byteSize: 10,
    });
    await replaceKnowledgeChunks(
      tenantA,
      source.id,
      [chunk(0, 'a', 1), chunk(1, 'b', 2), chunk(2, 'c', 3)],
      MODEL,
    );
    await finishKnowledgeSourceIngestion(tenantA, source.id, {
      checksum: 'c',
      charCount: 3,
      chunkCount: 3,
      embeddingModel: MODEL,
      embeddingDimensions: DIMS,
    });

    const [, second] = await listKnowledgeChunks(tenantA, source.id);
    const afterDelete = await deleteKnowledgeChunk(tenantA, second!.id);
    assert.equal(afterDelete.chunkCount, 2);
    assert.equal((await getKnowledgeSource(tenantA, source.id))?.chunkCount, 2);
    await assert.rejects(deleteKnowledgeChunk(tenantA, second!.id), KnowledgeChunkNotFoundError);

    const { storageKey } = await deleteKnowledgeSource(tenantA, source.id);
    assert.equal(storageKey, `tenants/${tenantA}/arquivo.pdf`);
    assert.equal(await getKnowledgeSource(tenantA, source.id), null);
    assert.equal(await countKnowledgeChunks(tenantA, source.id), 0);
    await assert.rejects(deleteKnowledgeSource(tenantA, source.id), KnowledgeSourceNotFoundError);
  });

  it('busca por similaridade devolve o trecho mais parecido e ignora fontes não prontas', async () => {
    // Sementes altas e exclusivas deste teste: os vetores dos outros testes ficam longe destes.
    const ready = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Perguntas frequentes',
      rawText: 'x',
    });
    await replaceKnowledgeChunks(
      tenantA,
      ready.id,
      [chunk(0, 'Entregamos em todo o Brasil.', 501), chunk(1, 'Aceitamos Pix e cartão.', 502)],
      MODEL,
    );
    await finishKnowledgeSourceIngestion(tenantA, ready.id, {
      checksum: 'c',
      charCount: 1,
      chunkCount: 2,
      embeddingModel: MODEL,
      embeddingDimensions: DIMS,
    });

    // Mesma base, mas a fonte NÃO terminou a ingestão: não pode aparecer na busca.
    const pendingSource = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Ainda processando',
      rawText: 'x',
    });
    await replaceKnowledgeChunks(
      tenantA,
      pendingSource.id,
      [chunk(0, 'Trecho de fonte não pronta.', 501)],
      MODEL,
    );

    const hits = await searchKnowledgeChunks(tenantA, vector(501), { limit: 5 });
    assert.equal(hits[0]?.content, 'Entregamos em todo o Brasil.');
    assert.equal(hits[0]?.sourceTitle, 'Perguntas frequentes');
    assert.ok(hits[0]!.similarity > 0.99, `similaridade inesperada: ${hits[0]?.similarity}`);
    assert.ok(
      !hits.some((h) => h.sourceId === pendingSource.id),
      'trecho de fonte não pronta apareceu na busca',
    );
    assert.ok(
      hits.length > 1 && hits[1]!.similarity < hits[0]!.similarity,
      'ordenação por distância',
    );

    // Corte por similaridade mínima: só o trecho praticamente idêntico sobrevive.
    const strict = await searchKnowledgeChunks(tenantA, vector(501), { minSimilarity: 0.99 });
    assert.deepEqual(
      strict.map((h) => h.content),
      ['Entregamos em todo o Brasil.'],
    );

    // Trecho sem embedding (ainda não processado) não entra.
    await withTenant(
      tenantA,
      (tx) =>
        tx.$executeRaw`UPDATE knowledge_chunks SET embedding = NULL WHERE tenant_id = ${tenantA}::uuid AND source_id = ${ready.id}::uuid AND position = 0`,
    );
    const afterNull = await searchKnowledgeChunks(tenantA, vector(501), { limit: 5 });
    assert.ok(!afterNull.some((h) => h.sourceId === ready.id && h.position === 0));

    // Vetor com dimensão errada é recusado antes de ir ao banco.
    await assert.rejects(searchKnowledgeChunks(tenantA, vector(1, 3)), EmbeddingDimensionsError);
  });

  it('RLS: um tenant não vê, não busca e não edita a base do outro', async () => {
    const source = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Segredo do A',
      rawText: 'CONTEUDO-SECRETO-DO-A',
    });
    await replaceKnowledgeChunks(tenantA, source.id, [chunk(0, 'CONTEUDO-SECRETO-DO-A', 1)], MODEL);
    await finishKnowledgeSourceIngestion(tenantA, source.id, {
      checksum: 'c',
      charCount: 1,
      chunkCount: 1,
      embeddingModel: MODEL,
      embeddingDimensions: DIMS,
    });
    const [chunkA] = await listKnowledgeChunks(tenantA, source.id);

    assert.equal(await getKnowledgeSource(tenantB, source.id), null);
    assert.equal(
      (await listKnowledgeSources(tenantB)).some((s) => s.id === source.id),
      false,
    );
    assert.equal((await listKnowledgeChunks(tenantB, source.id)).length, 0);
    assert.equal((await searchKnowledgeChunks(tenantB, vector(1), { limit: 10 })).length, 0);
    await assert.rejects(
      updateKnowledgeChunkContent(tenantB, chunkA!.id, 'invadido'),
      KnowledgeChunkNotFoundError,
    );
    await assert.rejects(deleteKnowledgeChunk(tenantB, chunkA!.id), KnowledgeChunkNotFoundError);
    await assert.rejects(deleteKnowledgeSource(tenantB, source.id), KnowledgeSourceNotFoundError);
    await assert.rejects(
      claimKnowledgeSourceForIngestion(tenantB, source.id),
      KnowledgeSourceNotFoundError,
    );
    // E o conteúdo continua intacto para o dono.
    assert.equal(
      (await listKnowledgeChunks(tenantA, source.id))[0]?.content,
      'CONTEUDO-SECRETO-DO-A',
    );
  });
});
