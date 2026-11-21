import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS as DIMS,
  getKnowledgeSource,
  listKnowledgeChunks,
  replaceKnowledgeChunks,
} from '@megabot/database';
import { signUpVerified, startTestApp, type TestApp } from './helpers';

const PDF = readFileSync(
  join(__dirname, '..', '..', '..', 'packages', 'knowledge', 'tests', 'fixtures', 'politica.pdf'),
);
const SEGREDO = 'CONTEUDO-SECRETO-DO-ARQUIVO';

function vector(seed: number): number[] {
  const raw = Array.from({ length: DIMS }, (_, i) => Math.sin((i + 1) * (seed + 1)));
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

interface SourceDto {
  id: string;
  kind: string;
  title: string;
  status: string;
  progress: number;
  chunkCount: number;
  sourceUrl: string | null;
  fileName: string | null;
  byteSize: number | null;
  errorCode: string | null;
}

describe('API da base de conhecimento (T2.2)', () => {
  let t: TestApp;
  const logs: string[] = [];
  let cookieA = '';
  let cookieB = '';
  let tenantA = '';
  let tenantB = '';

  const api = (path: string, init: Parameters<TestApp['api']>[1] = {}) =>
    t.api(`/knowledge${path}`, init);
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  before(async () => {
    t = await startTestApp({
      config: { logLevel: 'info' },
      logStream: { write: (chunk: string) => void logs.push(chunk) },
    });
    cookieA = await signUpVerified(t, t.newEmail('kb-a'), 'Cliente A');
    cookieB = await signUpVerified(t, t.newEmail('kb-b'), 'Cliente B');
    const tenantOf = async (cookie: string) =>
      (await json<{ tenant: { id: string } }>(await t.api('/me', { cookie }))).tenant.id;
    tenantA = await tenantOf(cookieA);
    tenantB = await tenantOf(cookieB);
  });

  after(async () => {
    await t.close();
  });

  it('sem sessão: 401 em tudo', async () => {
    for (const [path, init] of [
      ['/sources', {}],
      ['/sources', { body: { kind: 'text', text: 'oi' } }],
      ['/limits', {}],
      ['/sources/upload?fileName=a.txt', { method: 'POST', rawBody: 'x' }],
    ] as const) {
      assert.equal((await api(path, init)).status, 401, path);
    }
  });

  it('limites: tamanho e extensões aceitas', async () => {
    const response = await api('/limits', { cookie: cookieA });
    assert.equal(response.status, 200);
    const limits = await json<{ maxUploadBytes: number; acceptedExtensions: string[] }>(response);
    assert.equal(limits.maxUploadBytes, 20 * 1024 * 1024);
    assert.ok(limits.acceptedExtensions.includes('.pdf'));
    assert.ok(limits.acceptedExtensions.includes('.xlsx'));
  });

  it('upload de PDF: 201, fonte pendente e arquivo guardado no storage', async () => {
    const response = await api('/sources/upload?fileName=Pol%C3%ADtica%20de%20trocas.pdf', {
      method: 'POST',
      cookie: cookieA,
      rawBody: PDF.toString('latin1'),
      headers: { 'Content-Type': 'application/pdf' },
    });
    assert.equal(response.status, 201);
    const source = await json<SourceDto>(response);
    assert.equal(source.kind, 'upload');
    assert.equal(source.title, 'Política de trocas.pdf');
    assert.equal(source.status, 'pending');
    assert.equal(source.progress, 0);
    assert.equal(source.chunkCount, 0);
    assert.equal(source.fileName, 'Política de trocas.pdf');
    assert.ok((source.byteSize ?? 0) > 1000);

    // O arquivo foi para o storage, na pasta do tenant.
    const tenantDir = join(t.storageDir, 'tenants', tenantA, 'knowledge', source.id);
    assert.deepEqual(await readdir(tenantDir), ['politica-de-trocas.pdf']);
  });

  it('upload: formato não suportado, arquivo vazio e nome ausente são recusados', async () => {
    const bad = await api('/sources/upload?fileName=contrato.docx', {
      method: 'POST',
      cookie: cookieA,
      rawBody: 'conteúdo',
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /Converta para PDF/);

    const empty = await api('/sources/upload?fileName=vazio.txt', {
      method: 'POST',
      cookie: cookieA,
      rawBody: '',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(empty.status, 400);

    const noName = await api('/sources/upload', {
      method: 'POST',
      cookie: cookieA,
      rawBody: 'x',
      headers: { 'Content-Type': 'text/plain' },
    });
    assert.equal(noName.status, 400);
    assert.match(await noName.text(), /fileName/);
  });

  it('upload maior que o limite é recusado pelo servidor (413) e não guarda nada', async () => {
    const small = await startTestApp({ config: { knowledge: { maxUploadBytes: 1024 } } });
    try {
      const cookie = await signUpVerified(small, small.newEmail('kb-limite'), 'Limite');
      const response = await small.api('/knowledge/sources/upload?fileName=grande.txt', {
        method: 'POST',
        cookie,
        rawBody: 'x'.repeat(5000),
        headers: { 'Content-Type': 'text/plain' },
      });
      assert.equal(response.status, 413);
      const list = await small.api('/knowledge/sources', { cookie });
      assert.deepEqual(await list.json(), []);
    } finally {
      await small.close();
    }
  });

  it('fonte por URL: título vem do endereço; URL inválida é recusada', async () => {
    const ok = await api('/sources', {
      cookie: cookieA,
      body: { kind: 'url', url: 'https://loja.exemplo.com.br/trocas' },
    });
    assert.equal(ok.status, 201);
    const source = await json<SourceDto>(ok);
    assert.equal(source.kind, 'url');
    assert.equal(source.sourceUrl, 'https://loja.exemplo.com.br/trocas');
    assert.equal(source.title, 'loja.exemplo.com.br/trocas');
    assert.equal(source.status, 'pending');

    for (const url of ['nao-e-url', 'file:///etc/passwd', 'ftp://x.com']) {
      const response = await api('/sources', { cookie: cookieA, body: { kind: 'url', url } });
      assert.equal(response.status, 400, url);
    }
  });

  it('fonte por texto colado: título vem do começo do texto; vazio e gigante são recusados', async () => {
    const ok = await api('/sources', {
      cookie: cookieA,
      body: { kind: 'text', text: '  Trabalhamos de segunda a sexta, das 9h às 18h.  ' },
    });
    assert.equal(ok.status, 201);
    const source = await json<SourceDto>(ok);
    assert.equal(source.kind, 'text');
    assert.match(source.title, /^Trabalhamos de segunda a sexta/);

    assert.equal(
      (await api('/sources', { cookie: cookieA, body: { kind: 'text', text: '   ' } })).status,
      400,
    );
    assert.equal(
      (
        await api('/sources', {
          cookie: cookieA,
          body: { kind: 'text', text: 'x'.repeat(600_000) },
        })
      ).status,
      400,
    );
    // Corpo malformado: campo desconhecido, kind errado, falta url/text.
    for (const body of [
      { kind: 'url' },
      { kind: 'arquivo', url: 'https://x.com' },
      { kind: 'text', text: 'ok', extra: 1 },
    ]) {
      assert.equal((await api('/sources', { cookie: cookieA, body })).status, 400);
    }
  });

  it('lista as fontes do tenant, da mais nova para a mais antiga', async () => {
    const list = await json<SourceDto[]>(await api('/sources', { cookie: cookieA }));
    assert.ok(list.length >= 3);
    assert.deepEqual([...list].sort((a, b) => b.id.localeCompare(a.id)).length, list.length);
    assert.equal(list[0]?.kind, 'text', 'a última criada vem primeiro');
  });

  it('um tenant não vê nem mexe na base do outro', async () => {
    const mine = await json<SourceDto>(
      await api('/sources', { cookie: cookieA, body: { kind: 'text', text: SEGREDO } }),
    );
    const listB = await json<SourceDto[]>(await api('/sources', { cookie: cookieB }));
    assert.equal(
      listB.some((s) => s.id === mine.id),
      false,
    );
    assert.ok(!JSON.stringify(listB).includes(SEGREDO));

    assert.equal((await api(`/sources/${mine.id}`, { cookie: cookieB })).status, 404);
    assert.equal(
      (await api(`/sources/${mine.id}`, { cookie: cookieB, method: 'DELETE' })).status,
      404,
    );
    assert.equal(
      (await api(`/sources/${mine.id}/reingest`, { cookie: cookieB, method: 'POST' })).status,
      404,
    );
    assert.equal((await api(`/sources/${mine.id}/chunks`, { cookie: cookieB })).status, 404);
    // E continua lá para o dono.
    assert.equal((await api(`/sources/${mine.id}`, { cookie: cookieA })).status, 200);
  });

  it('id inválido e fonte inexistente', async () => {
    assert.equal((await api('/sources/nao-e-uuid', { cookie: cookieA })).status, 400);
    assert.equal((await api(`/sources/${randomUUID()}`, { cookie: cookieA })).status, 404);
  });

  it('trechos: lista com total e paginação, edição e exclusão', async () => {
    const source = await json<SourceDto>(
      await api('/sources', { cookie: cookieA, body: { kind: 'text', text: 'base para trechos' } }),
    );
    await replaceKnowledgeChunks(
      tenantA,
      source.id,
      Array.from({ length: 5 }, (_, i) => ({
        position: i,
        content: `Trecho número ${i}`,
        heading: i === 0 ? 'Introdução' : null,
        embedding: vector(i),
      })),
      'modelo-teste',
    );

    const page = await json<{ total: number; items: Array<Record<string, unknown>> }>(
      await api(`/sources/${source.id}/chunks?limit=2&offset=1`, { cookie: cookieA }),
    );
    assert.equal(page.total, 5);
    assert.deepEqual(
      page.items.map((c) => c.position),
      [1, 2],
    );
    assert.equal(page.items[0]!.hasEmbedding, true);
    assert.equal(page.items[0]!.embeddingStale, false);
    assert.equal(page.items[0]!.edited, false);
    // O vetor nunca é devolvido.
    assert.ok(!('embedding' in page.items[0]!));

    const all = await json<{ items: Array<{ id: string; position: number }> }>(
      await api(`/sources/${source.id}/chunks`, { cookie: cookieA }),
    );
    const target = all.items[0]!;

    const edited = await api(`/chunks/${target.id}`, {
      method: 'PATCH',
      cookie: cookieA,
      body: { content: '  Texto corrigido à mão  ' },
    });
    assert.equal(edited.status, 200);
    const chunk = await json<Record<string, unknown>>(edited);
    assert.equal(chunk.content, 'Texto corrigido à mão');
    assert.equal(chunk.edited, true);
    assert.equal(chunk.embeddingStale, true, 'o embedding será recalculado pelo worker');

    // Conteúdo vazio, gigante e campo desconhecido.
    for (const body of [
      { content: '   ' },
      { content: 'x'.repeat(9000) },
      { content: 'ok', extra: 1 },
    ]) {
      assert.equal(
        (await api(`/chunks/${target.id}`, { method: 'PATCH', cookie: cookieA, body })).status,
        400,
      );
    }
    // Trecho de outro tenant (e inexistente): 404.
    assert.equal(
      (
        await api(`/chunks/${target.id}`, {
          method: 'PATCH',
          cookie: cookieB,
          body: { content: 'x' },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await api(`/chunks/${randomUUID()}`, {
          method: 'PATCH',
          cookie: cookieA,
          body: { content: 'x' },
        })
      ).status,
      404,
    );

    const removed = await api(`/chunks/${target.id}`, { method: 'DELETE', cookie: cookieA });
    assert.equal(removed.status, 204);
    assert.equal(
      (await api(`/chunks/${target.id}`, { method: 'DELETE', cookie: cookieA })).status,
      404,
    );
    assert.equal((await getKnowledgeSource(tenantA, source.id))?.chunkCount, 4);
  });

  it('reingestão: volta para pending; durante o processamento devolve 409', async () => {
    const source = await json<SourceDto>(
      await api('/sources', { cookie: cookieA, body: { kind: 'text', text: 'para reingerir' } }),
    );
    const response = await api(`/sources/${source.id}/reingest`, {
      method: 'POST',
      cookie: cookieA,
    });
    assert.equal(response.status, 200);
    assert.equal((await json<SourceDto>(response)).status, 'pending');

    // Simula o worker tendo pegado a fonte.
    const { claimKnowledgeSourceForIngestion } = await import('@megabot/database');
    await claimKnowledgeSourceForIngestion(tenantA, source.id);
    const conflict = await api(`/sources/${source.id}/reingest`, {
      method: 'POST',
      cookie: cookieA,
    });
    assert.equal(conflict.status, 409);
  });

  it('apagar a fonte remove os trechos e o arquivo do storage', async () => {
    const created = await json<SourceDto>(
      await api('/sources/upload?fileName=para-apagar.txt', {
        method: 'POST',
        cookie: cookieA,
        rawBody: 'conteúdo que será apagado',
        headers: { 'Content-Type': 'text/plain' },
      }),
    );
    await replaceKnowledgeChunks(
      tenantA,
      created.id,
      [{ position: 0, content: 'trecho', embedding: vector(1) }],
      'modelo-teste',
    );
    const dir = join(t.storageDir, 'tenants', tenantA, 'knowledge', created.id);
    assert.equal((await readdir(dir)).length, 1);

    const response = await api(`/sources/${created.id}`, { method: 'DELETE', cookie: cookieA });
    assert.equal(response.status, 204);
    assert.equal(await getKnowledgeSource(tenantA, created.id), null);
    assert.equal((await listKnowledgeChunks(tenantA, created.id)).length, 0);
    // O arquivo some do storage (a pasta pode continuar existindo, vazia).
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });

  it('logs e métricas levam tenant_id e nunca o conteúdo enviado', async () => {
    const lines = logs
      .flatMap((chunk) => chunk.split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const created = lines.filter((l) => l.event === 'knowledge.source.created');
    assert.ok(created.length >= 4);
    assert.ok(created.every((l) => typeof l.tenant_id === 'string' && l.source_id));
    assert.ok(lines.some((l) => l.event === 'knowledge.chunk.updated' && l.tenant_id === tenantA));
    assert.ok(lines.some((l) => l.event === 'knowledge.source.deleted' && l.tenant_id === tenantA));

    const metrics = lines.filter((l) => l.metric === 'knowledge_sources_total');
    assert.ok(metrics.some((m) => m.outcome === 'created' && m.tenant_id === tenantA));
    assert.ok(metrics.some((m) => m.outcome === 'rejected'));
    assert.ok(metrics.every((m) => typeof m.tenant_id === 'string'));

    const all = logs.join('');
    assert.ok(!all.includes(SEGREDO), 'o texto da fonte apareceu no log');
    assert.ok(!all.includes('Texto corrigido à mão'), 'o texto do trecho apareceu no log');
  });
});
