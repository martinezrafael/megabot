import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchMe, safeNext } from '../src/lib/me';

const ME = {
  user: { id: 'u1', email: 'ana@exemplo.com', name: 'Ana', image: null, emailVerified: true },
  tenant: { id: 't1', role: 'OWNER' as const },
};

function stubFetch(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('fetchMe', () => {
  it('200: devolve o usuário e repassa cookie, IP e request id para a API', async () => {
    const { fetchImpl, calls } = stubFetch(Response.json(ME));
    const me = await fetchMe({
      apiUrl: 'http://api:3000',
      cookie: 'better-auth.session_token=abc',
      forwardedFor: '203.0.113.7',
      requestId: 'trace-12345678',
      fetchImpl,
    });

    assert.deepEqual(me, ME);
    assert.equal(calls[0].url, 'http://api:3000/me');
    assert.deepEqual(calls[0].init.headers, {
      cookie: 'better-auth.session_token=abc',
      'x-forwarded-for': '203.0.113.7',
      'x-request-id': 'trace-12345678',
    });
    assert.equal(calls[0].init.cache, 'no-store');
  });

  it('401: sem sessão devolve null', async () => {
    const { fetchImpl } = stubFetch(Response.json({ statusCode: 401 }, { status: 401 }));
    assert.equal(await fetchMe({ apiUrl: 'http://api', cookie: '', fetchImpl }), null);
  });

  it('outros erros (ex.: 500, 429) lançam, em vez de parecer "deslogado"', async () => {
    for (const status of [500, 429, 503]) {
      const { fetchImpl } = stubFetch(Response.json({}, { status }));
      await assert.rejects(
        fetchMe({ apiUrl: 'http://api', cookie: '', fetchImpl }),
        new RegExp(String(status)),
      );
    }
  });

  it('não envia cabeçalhos opcionais quando ausentes', async () => {
    const { fetchImpl, calls } = stubFetch(Response.json(ME));
    await fetchMe({ apiUrl: 'http://api', cookie: 'a=b', fetchImpl });
    assert.deepEqual(calls[0].init.headers, { cookie: 'a=b' });
  });
});

describe('safeNext', () => {
  it('aceita só caminhos internos', () => {
    assert.equal(safeNext('/settings'), '/settings');
    assert.equal(safeNext(undefined), '/dashboard');
    assert.equal(safeNext('https://evil.example'), '/dashboard');
    assert.equal(safeNext('//evil.example'), '/dashboard');
  });
});
