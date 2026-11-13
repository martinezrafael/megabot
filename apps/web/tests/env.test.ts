import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebEnv, WebEnvError } from '../src/env';

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    parseWebEnv(env);
  } catch (error) {
    assert.ok(error instanceof WebEnvError);
    return error.issues;
  }
  assert.fail('deveria ter lançado WebEnvError');
}

describe('Configuração do web validada com Zod', () => {
  it('em desenvolvimento usa os padrões locais', () => {
    assert.deepEqual(parseWebEnv({}), {
      publicApiUrl: 'http://localhost:3000',
      serverApiUrl: 'http://localhost:3000',
    });
  });

  it('o servidor usa API_URL (rede interna) quando definida', () => {
    const env = parseWebEnv({
      NEXT_PUBLIC_API_URL: 'https://api.exemplo.com',
      API_URL: 'http://api:3000',
    });
    assert.equal(env.publicApiUrl, 'https://api.exemplo.com');
    assert.equal(env.serverApiUrl, 'http://api:3000');
  });

  it('variável vazia conta como não definida', () => {
    assert.equal(
      parseWebEnv({ NEXT_PUBLIC_API_URL: '', API_URL: '' }).publicApiUrl,
      'http://localhost:3000',
    );
  });

  it('rejeita URL inválida', () => {
    assert.ok(
      issuesOf({ NEXT_PUBLIC_API_URL: 'isso-nao-e-url' }).some((i) =>
        i.startsWith('NEXT_PUBLIC_API_URL'),
      ),
    );
  });

  it('em produção exige NEXT_PUBLIC_API_URL (não "adivinha" localhost)', () => {
    assert.ok(
      issuesOf({ NODE_ENV: 'production' }).some((i) => i.startsWith('NEXT_PUBLIC_API_URL')),
    );
    assert.equal(
      parseWebEnv({ NODE_ENV: 'production', NEXT_PUBLIC_API_URL: 'https://api.exemplo.com' })
        .publicApiUrl,
      'https://api.exemplo.com',
    );
  });
});
