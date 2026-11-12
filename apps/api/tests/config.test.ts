import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { ConfigError, loadConfig } from '../src/config';

const VALID_ENV = {
  DATABASE_URL: 'postgresql://megabot_app:megabot_pass@localhost:5432/megabot?schema=public',
  BETTER_AUTH_SECRET: 'um-segredo-de-teste-com-mais-de-32-caracteres',
};

function issuesOf(env: NodeJS.ProcessEnv): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, 'deveria lançar ConfigError');
    return error.issues;
  }
  assert.fail('deveria ter lançado ConfigError');
}

describe('Configuração validada com Zod', () => {
  it('aceita o mínimo e aplica os padrões de desenvolvimento', () => {
    const config = loadConfig(VALID_ENV);

    assert.equal(config.env, 'development');
    assert.equal(config.port, 3000);
    assert.equal(config.authUrl, 'http://localhost:3000');
    assert.equal(config.webUrl, 'http://localhost:3001');
    assert.equal(config.logLevel, 'info');
    assert.deepEqual(config.rateLimit, { windowMs: 60_000, max: 300, authMax: 20 });
    assert.equal(config.trustProxy, false);
    assert.equal(config.swaggerEnabled, true);
    assert.equal(config.google, undefined);
  });

  it('converte tipos (PORT, limites e TRUST_PROXY)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      PORT: '4000',
      RATE_LIMIT_WINDOW_SECONDS: '30',
      RATE_LIMIT_MAX: '50',
      RATE_LIMIT_AUTH_MAX: '5',
      TRUST_PROXY: '1',
    });

    assert.equal(config.port, 4000);
    assert.deepEqual(config.rateLimit, { windowMs: 30_000, max: 50, authMax: 5 });
    assert.equal(config.trustProxy, 1);
  });

  it('trata variável vazia como não definida (ex.: GOOGLE_CLIENT_ID=)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      GOOGLE_CLIENT_ID: '',
      GOOGLE_CLIENT_SECRET: '',
      WEB_URL: '',
    });
    assert.equal(config.google, undefined);
    assert.equal(config.webUrl, 'http://localhost:3001');
  });

  it('lista TODOS os problemas de uma vez', () => {
    const issues = issuesOf({ PORT: 'abc' });

    assert.ok(issues.some((i) => i.startsWith('DATABASE_URL')));
    assert.ok(issues.some((i) => i.startsWith('BETTER_AUTH_SECRET')));
    assert.ok(issues.some((i) => i.startsWith('PORT')));
  });

  it('rejeita segredo curto e o valor de exemplo do .env.example', () => {
    assert.ok(
      issuesOf({ ...VALID_ENV, BETTER_AUTH_SECRET: 'curto' }).some((i) =>
        i.includes('32 caracteres'),
      ),
    );
    assert.ok(
      issuesOf({
        ...VALID_ENV,
        BETTER_AUTH_SECRET: 'troque-por-um-segredo-aleatorio-com-32-ou-mais-caracteres',
      }).some((i) => i.includes('valor de exemplo')),
    );
  });

  it('rejeita DATABASE_URL que não é postgresql://', () => {
    assert.ok(
      issuesOf({ ...VALID_ENV, DATABASE_URL: 'mysql://x' }).some((i) =>
        i.startsWith('DATABASE_URL'),
      ),
    );
  });

  it('exige as credenciais do Google em par', () => {
    const issues = issuesOf({ ...VALID_ENV, GOOGLE_CLIENT_ID: 'so-o-id' });
    assert.ok(issues.some((i) => i.includes('GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET')));

    const ok = loadConfig({ ...VALID_ENV, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' });
    assert.deepEqual(ok.google, { clientId: 'id', clientSecret: 'secret' });
  });

  it('em produção exige URLs explícitas e desliga o Swagger por padrão', () => {
    const issues = issuesOf({ ...VALID_ENV, NODE_ENV: 'production' });
    assert.ok(issues.some((i) => i.startsWith('BETTER_AUTH_URL')));
    assert.ok(issues.some((i) => i.startsWith('WEB_URL')));

    const config = loadConfig({
      ...VALID_ENV,
      NODE_ENV: 'production',
      BETTER_AUTH_URL: 'https://api.exemplo.com',
      WEB_URL: 'https://app.exemplo.com',
    });
    assert.equal(config.swaggerEnabled, false);
  });

  it('FALHA RÁPIDA: o processo não sobe com configuração inválida', () => {
    const apiDir = path.resolve(__dirname, '..');
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: apiDir,
      // Ambiente quase vazio: sem DATABASE_URL nem BETTER_AUTH_SECRET.
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Configuração inválida/);
    assert.match(result.stderr, /BETTER_AUTH_SECRET/);
    assert.match(result.stderr, /DATABASE_URL/);
  });
});
