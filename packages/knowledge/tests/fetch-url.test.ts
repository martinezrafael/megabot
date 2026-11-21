import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import {
  KnowledgeError,
  assertHttpUrl,
  assertPublicHost,
  fetchRemoteDocument,
  isPrivateAddress,
  type LookupFn,
} from '../src';

/** O servidor de teste roda em 127.0.0.1; este lookup finge que o domínio é público. */
const publicLookup: LookupFn = async () => [{ address: '93.184.216.34', family: 4 }];

describe('URL: validação e proteção contra SSRF', () => {
  it('aceita http/https e recusa o resto', () => {
    assert.equal(assertHttpUrl(' https://exemplo.com.br/sobre ').hostname, 'exemplo.com.br');
    for (const bad of [
      '',
      'exemplo.com.br',
      'file:///etc/passwd',
      'ftp://a.com',
      'javascript:alert(1)',
    ]) {
      assert.throws(() => assertHttpUrl(bad), { code: 'url_invalida' });
    }
  });

  it('recusa endereço com usuário e senha embutidos', () => {
    assert.throws(() => assertHttpUrl('https://user:senha@exemplo.com'), {
      code: 'url_invalida',
    });
  });

  it('reconhece endereços de rede interna', () => {
    const privados = [
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // metadados de nuvem: o alvo clássico de SSRF
      '0.0.0.0',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      '::',
      'fc00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '999.1.1.1',
      'nao-e-ip',
    ];
    for (const address of privados) {
      assert.equal(isPrivateAddress(address), true, `${address} deveria ser privado`);
    }
    for (const address of [
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '192.167.1.1',
      '2606:4700::1',
    ]) {
      assert.equal(isPrivateAddress(address), false, `${address} deveria ser público`);
    }
  });

  it('bloqueia nomes internos e IPs privados antes de qualquer requisição', async () => {
    for (const host of ['http://localhost:3000/x', 'http://api.local/x', 'http://db.internal/x']) {
      await assert.rejects(assertPublicHost(assertHttpUrl(host), publicLookup), {
        code: 'url_bloqueada',
      });
    }
    await assert.rejects(
      assertPublicHost(assertHttpUrl('http://169.254.169.254/latest/meta-data')),
      {
        code: 'url_bloqueada',
      },
    );
    // Domínio público que RESOLVE para IP interno também é bloqueado.
    await assert.rejects(
      assertPublicHost(assertHttpUrl('https://interno.exemplo.com'), async () => [
        { address: '10.1.2.3', family: 4 },
      ]),
      { code: 'url_bloqueada' },
    );
    // DNS que não resolve: erro de acesso (vale tentar de novo).
    await assert.rejects(
      assertPublicHost(assertHttpUrl('https://nao-existe.exemplo'), async () => {
        throw new Error('ENOTFOUND');
      }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'url_inacessivel');
        assert.equal(error.retryable, true);
        return true;
      },
    );
    await assert.doesNotReject(
      assertPublicHost(assertHttpUrl('https://exemplo.com'), publicLookup),
    );
  });
});

describe('download da URL (servidor HTTP local)', () => {
  let server: http.Server;
  let base = '';
  const requests: string[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      requests.push(req.url ?? '');
      const url = req.url ?? '/';
      if (url === '/pagina') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        return void res.end(
          '<html><head><title>Loja</title></head><body><h1>Sobre</h1><p>Texto da página.</p></body></html>',
        );
      }
      if (url === '/latin') {
        res.setHeader('content-type', 'text/html; charset=iso-8859-1');
        return void res.end(Buffer.from('<html><body><p>Promoção</p></body></html>', 'latin1'));
      }
      if (url === '/catalogo.csv') {
        res.setHeader('content-type', 'text/plain');
        return void res.end('SKU,Nome\nA1,Caneca\n');
      }
      if (url === '/redireciona') {
        res.statusCode = 302;
        res.setHeader('location', '/pagina');
        return void res.end();
      }
      if (url === '/redireciona-interno') {
        res.statusCode = 302;
        res.setHeader('location', 'http://169.254.169.254/latest/meta-data');
        return void res.end();
      }
      if (url === '/loop') {
        res.statusCode = 302;
        res.setHeader('location', '/loop');
        return void res.end();
      }
      if (url === '/grande') {
        // Em pedaços, sem content-length: é o caso em que só o download revela o tamanho.
        res.setHeader('content-type', 'text/plain');
        for (let i = 0; i < 50; i += 1) res.write('x'.repeat(1000));
        return void res.end();
      }
      if (url === '/grande-declarado') {
        res.setHeader('content-type', 'text/plain');
        res.setHeader('content-length', '999999999');
        return void res.end('x');
      }
      if (url === '/imagem') {
        res.setHeader('content-type', 'image/png');
        return void res.end(Buffer.from([0x89, 0x50]));
      }
      if (url === '/vazia') {
        res.setHeader('content-type', 'text/html');
        return void res.end('');
      }
      if (url === '/lenta') return; // nunca responde
      if (url === '/404') {
        res.statusCode = 404;
        return void res.end('nao achei');
      }
      if (url === '/500') {
        res.statusCode = 503;
        return void res.end('instavel');
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * O código só aceita hosts públicos, e o servidor de teste é 127.0.0.1. Então a URL usa um
   * domínio de teste ("exemplo.test", que o lookup finge resolver para um IP público) e este
   * fetch troca a origem pela do servidor local no último instante. Assim as proteções são
   * exercitadas de verdade, sem exceção nenhuma no código de produção.
   */
  const ORIGIN = 'https://exemplo.test';
  const rewritingFetch =
    (target: () => string): typeof fetch =>
    (input, init) =>
      fetch(String(input).replace(ORIGIN, target()), init);

  const get = (path: string, options = {}) =>
    fetchRemoteDocument(`${ORIGIN}${path}`, {
      lookup: publicLookup,
      fetch: rewritingFetch(() => base),
      ...options,
    });

  it('baixa uma página HTML com tipo, charset e URL final', async () => {
    const doc = await get('/pagina');
    assert.equal(doc.mimeType, 'text/html');
    assert.equal(doc.charset, 'utf-8');
    assert.equal(doc.format, 'html');
    assert.equal(doc.finalUrl, `${ORIGIN}/pagina`);
    assert.match(Buffer.from(doc.bytes).toString('utf8'), /Texto da página/);
  });

  it('descobre o formato pelo nome quando o tipo é genérico', async () => {
    const doc = await get('/catalogo.csv');
    assert.equal(doc.format, 'csv');
    assert.equal(doc.fileName, 'catalogo.csv');
  });

  it('informa o charset declarado (para decodificar latin-1 depois)', async () => {
    const doc = await get('/latin');
    assert.equal(doc.charset, 'iso-8859-1');
  });

  it('segue redirecionamento, revalidando o destino', async () => {
    const doc = await get('/redireciona');
    assert.equal(doc.finalUrl, `${ORIGIN}/pagina`);

    await assert.rejects(get('/redireciona-interno'), { code: 'url_bloqueada' });
    await assert.rejects(get('/loop'), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'url_inacessivel');
      assert.match(error.message, /redirecionamentos demais/);
      return true;
    });
  });

  it('respeita o limite de tamanho (declarado e real)', async () => {
    await assert.rejects(get('/grande-declarado', { maxBytes: 1000 }), {
      code: 'arquivo_grande',
    });
    await assert.rejects(get('/grande', { maxBytes: 1000 }), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'arquivo_grande');
      assert.match(error.message, /interrompido/);
      return true;
    });
    assert.ok((await get('/grande', { maxBytes: 100_000 })).bytes.byteLength === 50_000);
  });

  it('erro do site: 404 não repete, 503 repete', async () => {
    await assert.rejects(get('/404'), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'url_erro_http');
      assert.equal(error.retryable, false);
      assert.match(error.message, /sem login/);
      return true;
    });
    await assert.rejects(get('/500'), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.retryable, true);
      return true;
    });
  });

  it('tipo não suportado e página vazia', async () => {
    await assert.rejects(get('/imagem'), { code: 'formato_nao_suportado' });
    await assert.rejects(get('/vazia'), { code: 'documento_vazio' });
  });

  it('site que não responde vira erro de acesso (repetível), sem travar', async () => {
    await assert.rejects(get('/lenta', { timeoutMs: 150 }), (error: unknown) => {
      assert.ok(error instanceof KnowledgeError);
      assert.equal(error.code, 'url_inacessivel');
      assert.equal(error.retryable, true);
      assert.match(error.message, /não respondeu/);
      return true;
    });
  });

  it('servidor fora do ar vira erro de acesso repetível', async () => {
    await assert.rejects(
      fetchRemoteDocument(`${ORIGIN}/x`, {
        lookup: publicLookup,
        fetch: rewritingFetch(() => 'http://127.0.0.1:1'),
      }),
      (error: unknown) => {
        assert.ok(error instanceof KnowledgeError);
        assert.equal(error.code, 'url_inacessivel');
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it('manda um user agent honesto (sites que bloqueiam anônimos)', async () => {
    const seen: Array<Record<string, string>> = [];
    await fetchRemoteDocument(`${ORIGIN}/pagina`, {
      lookup: publicLookup,
      fetch: async (input, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        return rewritingFetch(() => base)(input, init);
      },
    });
    assert.match(seen[0]!['user-agent']!, /MegabotKnowledgeBot/);
    assert.match(seen[0]!['accept-language']!, /pt-BR/);
  });
});
