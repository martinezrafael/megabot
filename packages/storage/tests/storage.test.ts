import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, describe, it } from 'node:test';
import {
  DEFAULT_LOCAL_DIR,
  LocalObjectStorage,
  S3ObjectStorage,
  StorageError,
  assertValidKey,
  buildKnowledgeObjectKey,
  createStorageFromEnv,
  loadStorageConfig,
  slugifyFileName,
  type S3Like,
} from '../src';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => Buffer.from(data).toString('utf8');

describe('chaves de arquivo', () => {
  it('monta a chave com tenant e fonte, e deixa o nome seguro', () => {
    const key = buildKnowledgeObjectKey({
      tenantId: '11111111-1111-4111-8111-111111111111',
      sourceId: '22222222-2222-4222-8222-222222222222',
      fileName: 'Política de Trocas (2026).PDF',
    });
    assert.equal(
      key,
      'tenants/11111111-1111-4111-8111-111111111111/knowledge/22222222-2222-4222-8222-222222222222/politica-de-trocas-2026.pdf',
    );
  });

  it('nome de arquivo: tira acento, espaço e caractere estranho', () => {
    assert.equal(slugifyFileName('Catálogo Março.xlsx'), 'catalogo-marco.xlsx');
    // Caminho não vira nome: só o último pedaço sobrevive.
    assert.equal(slugifyFileName('../../etc/passwd'), 'passwd');
    assert.equal(slugifyFileName('C:\\Users\\ana\\Relatório Final.pdf'), 'relatorio-final.pdf');
    assert.equal(slugifyFileName('   '), 'arquivo');
    assert.equal(slugifyFileName('sem-extensao'), 'sem-extensao');
    assert.equal(slugifyFileName('ruim.tar.gz'), 'ruim-tar.gz');
    assert.equal(slugifyFileName('x'.repeat(200) + '.pdf').length, 84);
  });

  it('recusa chave perigosa ou fora do padrão', () => {
    for (const bad of [
      '',
      '/absoluta/x.pdf',
      'tenants/../segredo.pdf',
      'tenants//x.pdf',
      'tenants/x/',
      'tenants/x.',
      'tenants/x y.pdf',
      'tenants/\u0000.pdf',
      `tenants/${'a'.repeat(600)}`,
    ]) {
      assert.throws(
        () => assertValidKey(bad),
        (error: unknown) => {
          assert.ok(error instanceof StorageError);
          assert.equal(error.code, 'chave_invalida');
          return true;
        },
        `deveria recusar: ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(assertValidKey('tenants/a/knowledge/b/c.pdf'), 'tenants/a/knowledge/b/c.pdf');
  });
});

describe('driver local (disco)', () => {
  let dir = '';
  let storage: LocalObjectStorage;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'megabot-storage-'));
    storage = new LocalObjectStorage(dir);
  });

  it('grava, lê, consulta e apaga', async () => {
    const key = 'tenants/t1/knowledge/s1/arquivo.txt';
    assert.equal(await storage.exists(key), false);
    await storage.put(key, bytes('conteúdo com acento'), { contentType: 'text/plain' });
    assert.equal(await storage.exists(key), true);
    assert.equal(text(await storage.get(key)), 'conteúdo com acento');
    // Gravou de verdade no disco, na subpasta esperada.
    assert.equal((await readFile(join(dir, key))).toString('utf8'), 'conteúdo com acento');

    await storage.delete(key);
    assert.equal(await storage.exists(key), false);
    // Apagar duas vezes não é erro.
    await assert.doesNotReject(storage.delete(key));
  });

  it('mantém bytes binários intactos', async () => {
    const key = 'tenants/t1/knowledge/s2/arquivo.bin';
    const data = new Uint8Array([0, 1, 2, 250, 251, 255, 0, 13, 10]);
    await storage.put(key, data);
    assert.deepEqual(await storage.get(key), data);
  });

  it('chave que não existe vira erro nao_encontrado (não repetível)', async () => {
    await assert.rejects(storage.get('tenants/t1/knowledge/s9/sumiu.pdf'), (error: unknown) => {
      assert.ok(error instanceof StorageError);
      assert.equal(error.code, 'nao_encontrado');
      assert.equal(error.retryable, false);
      return true;
    });
  });

  it('não deixa escapar da pasta raiz', async () => {
    await writeFile(join(dir, '..', 'fora.txt'), 'segredo').catch(() => undefined);
    for (const key of ['../fora.txt', 'tenants/../../fora.txt', '/etc/hosts']) {
      await assert.rejects(storage.get(key), { code: 'chave_invalida' });
      await assert.rejects(storage.put(key, bytes('x')), { code: 'chave_invalida' });
    }
  });
});

describe('driver S3/R2', () => {
  /** Dublê do cliente da AWS: guarda os comandos e devolve o que o teste quiser. */
  function fakeClient(handler: (name: string, input: Record<string, unknown>) => unknown) {
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client: S3Like = {
      send: async (command: unknown) => {
        const typed = command as { constructor: { name: string }; input: Record<string, unknown> };
        const call = { name: typed.constructor.name, input: typed.input };
        calls.push(call);
        const result = handler(call.name, call.input);
        if (result instanceof Error) throw result;
        return result;
      },
    };
    return { client, calls };
  }

  const awsError = (name: string, httpStatusCode: number) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });

  it('grava com bucket, chave e tipo; lê de volta', async () => {
    const stored = new Map<string, Uint8Array>();
    const { client, calls } = fakeClient((name, input) => {
      const key = String(input.Key);
      if (name === 'PutObjectCommand') {
        stored.set(key, input.Body as Uint8Array);
        return {};
      }
      if (name === 'GetObjectCommand') {
        const body = stored.get(key);
        if (!body) return awsError('NoSuchKey', 404);
        return { Body: { transformToByteArray: async () => body } };
      }
      if (name === 'HeadObjectCommand') {
        return stored.has(key) ? {} : awsError('NotFound', 404);
      }
      if (name === 'DeleteObjectCommand') {
        stored.delete(key);
        return {};
      }
      return {};
    });
    const storage = new S3ObjectStorage({ bucket: 'megabot-kb', client });

    await storage.put('tenants/t/knowledge/s/a.pdf', bytes('oi'), {
      contentType: 'application/pdf',
    });
    assert.deepEqual(calls[0]!.input, {
      Bucket: 'megabot-kb',
      Key: 'tenants/t/knowledge/s/a.pdf',
      Body: bytes('oi'),
      ContentLength: 2,
      ContentType: 'application/pdf',
    });
    assert.equal(text(await storage.get('tenants/t/knowledge/s/a.pdf')), 'oi');
    assert.equal(await storage.exists('tenants/t/knowledge/s/a.pdf'), true);
    await storage.delete('tenants/t/knowledge/s/a.pdf');
    assert.equal(await storage.exists('tenants/t/knowledge/s/a.pdf'), false);
  });

  it('traduz os erros da AWS: 404 some, 403 é configuração, 500 é repetível', async () => {
    const cases: Array<[Error, string, boolean]> = [
      [awsError('NoSuchKey', 404), 'nao_encontrado', false],
      [awsError('AccessDenied', 403), 'configuracao', false],
      [awsError('InvalidAccessKeyId', 401), 'configuracao', false],
      [awsError('InternalError', 500), 'indisponivel', true],
      [Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }), 'indisponivel', true],
    ];
    for (const [error, code, retryable] of cases) {
      const { client } = fakeClient(() => error);
      const storage = new S3ObjectStorage({ bucket: 'b', client });
      await assert.rejects(storage.get('tenants/t/k/s/a.pdf'), (thrown: unknown) => {
        assert.ok(thrown instanceof StorageError);
        assert.equal(thrown.code, code);
        assert.equal(thrown.retryable, retryable);
        return true;
      });
    }
  });

  it('apagar algo que não existe não é erro', async () => {
    const { client } = fakeClient(() => awsError('NoSuchKey', 404));
    const storage = new S3ObjectStorage({ bucket: 'b', client });
    await assert.doesNotReject(storage.delete('tenants/t/k/s/a.pdf'));
  });

  it('chave inválida nem chega a chamar o S3', async () => {
    const { client, calls } = fakeClient(() => ({}));
    const storage = new S3ObjectStorage({ bucket: 'b', client });
    await assert.rejects(storage.put('../fora.pdf', bytes('x')), { code: 'chave_invalida' });
    assert.equal(calls.length, 0);
  });

  it('reconhece a R2 pelo endpoint e exige bucket', () => {
    const { client } = fakeClient(() => ({}));
    assert.equal(
      new S3ObjectStorage({
        bucket: 'b',
        endpoint: 'https://conta.r2.cloudflarestorage.com',
        client,
      }).driver,
      'r2',
    );
    assert.equal(new S3ObjectStorage({ bucket: 'b', client }).driver, 's3');
    assert.throws(() => new S3ObjectStorage({ bucket: '  ', client }), { code: 'configuracao' });
  });
});

describe('configuração por ambiente', () => {
  it('padrão é o disco local', () => {
    const config = loadStorageConfig({});
    assert.deepEqual(
      { driver: config.driver, localDir: config.localDir },
      { driver: 'local', localDir: DEFAULT_LOCAL_DIR },
    );
    assert.equal(createStorageFromEnv({}).driver, 'local');
  });

  it('r2 completo monta o driver r2', () => {
    const env = {
      STORAGE_DRIVER: 'r2',
      STORAGE_BUCKET: 'megabot-kb',
      STORAGE_ENDPOINT: 'https://conta.r2.cloudflarestorage.com',
      STORAGE_ACCESS_KEY_ID: 'chave',
      STORAGE_SECRET_ACCESS_KEY: 'segredo',
    };
    const config = loadStorageConfig(env);
    assert.equal(config.driver, 'r2');
    assert.equal(config.bucket, 'megabot-kb');
    assert.equal(createStorageFromEnv(env).driver, 'r2');
  });

  it('r2/s3 sem bucket ou credenciais falha dizendo o que falta', () => {
    assert.throws(
      () => loadStorageConfig({ STORAGE_DRIVER: 'r2' }),
      (error: unknown) => {
        assert.ok(error instanceof StorageError);
        assert.equal(error.code, 'configuracao');
        for (const name of [
          'STORAGE_BUCKET',
          'STORAGE_ACCESS_KEY_ID',
          'STORAGE_SECRET_ACCESS_KEY',
          'STORAGE_ENDPOINT',
        ]) {
          assert.match(error.message, new RegExp(name));
        }
        return true;
      },
    );
    // S3 da AWS não precisa de endpoint.
    assert.doesNotThrow(() =>
      loadStorageConfig({
        STORAGE_DRIVER: 's3',
        STORAGE_BUCKET: 'b',
        STORAGE_ACCESS_KEY_ID: 'k',
        STORAGE_SECRET_ACCESS_KEY: 's',
      }),
    );
  });

  it('driver desconhecido e endpoint inválido são recusados; variável vazia conta como ausente', () => {
    assert.throws(() => loadStorageConfig({ STORAGE_DRIVER: 'ftp' }), { code: 'configuracao' });
    assert.throws(
      () =>
        loadStorageConfig({
          STORAGE_DRIVER: 'r2',
          STORAGE_BUCKET: 'b',
          STORAGE_ENDPOINT: 'nao-e-url',
          STORAGE_ACCESS_KEY_ID: 'k',
          STORAGE_SECRET_ACCESS_KEY: 's',
        }),
      /STORAGE_ENDPOINT/,
    );
    assert.equal(loadStorageConfig({ STORAGE_LOCAL_DIR: '' }).localDir, DEFAULT_LOCAL_DIR);
  });
});
