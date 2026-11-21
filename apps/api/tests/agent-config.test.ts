import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { signUpVerified, startTestApp, type TestApp } from './helpers';

interface ConfigDto {
  version: number;
  name: string;
  tone: string;
  greeting: string;
  tools: string[];
  rules: string[];
  createdByName: string | null;
  restoredFromVersion: number | null;
  createdAt: string | null;
  active: boolean;
}

interface PageDto {
  total: number;
  activeVersion: number;
  items: ConfigDto[];
}

interface OptionsDto {
  tones: { key: string; label: string; hint: string }[];
  tools: { key: string; label: string; description: string; status: string }[];
  maxNameLength: number;
  maxRules: number;
}

const SEGREDO = 'REGRA-SECRETA-DO-CLIENTE';

describe('API da configuração do agente (T2.4)', () => {
  let t: TestApp;
  const logs: string[] = [];
  let cookieA = '';
  let cookieB = '';
  let tenantA = '';

  const api = (path: string, init: Parameters<TestApp['api']>[1] = {}) =>
    t.api(`/agent-config${path}`, init);
  const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

  const corpo = (overrides: Record<string, unknown> = {}) => ({
    name: 'Bia',
    tone: 'amigavel',
    greeting: 'Oi! Eu sou a Bia, da Loja Modelo.',
    tools: ['base_conhecimento'],
    rules: ['Nunca prometa prazo que não está na base.'],
    ...overrides,
  });

  before(async () => {
    t = await startTestApp({
      config: { logLevel: 'info' },
      logStream: { write: (chunk: string) => void logs.push(chunk) },
    });
    cookieA = await signUpVerified(t, t.newEmail('agente-a'), 'Dona A');
    cookieB = await signUpVerified(t, t.newEmail('agente-b'), 'Dono B');
    tenantA = (await json<{ tenant: { id: string } }>(await t.api('/me', { cookie: cookieA })))
      .tenant.id;
  });

  after(async () => {
    await t.close();
  });

  it('sem sessão: 401 em tudo', async () => {
    for (const [path, init] of [
      ['', {}],
      ['', { method: 'PUT', body: corpo() }],
      ['/options', {}],
      ['/versions', {}],
      ['/versions/1', {}],
      ['/versions/1/restore', { method: 'POST' }],
    ] as const) {
      const response = await api(path, init);
      assert.equal(response.status, 401, `${init.method ?? 'GET'} ${path || '/'}`);
    }
  });

  it('opções: tons, catálogo de ferramentas e limites', async () => {
    const options = await json<OptionsDto>(await api('/options', { cookie: cookieA }));

    assert.deepEqual(
      options.tones.map((tone) => tone.key),
      ['formal', 'neutro', 'amigavel', 'descontraido'],
    );
    const base = options.tools.find((tool) => tool.key === 'base_conhecimento');
    assert.equal(base?.status, 'disponivel');
    assert.ok(options.tools.some((tool) => tool.status === 'em_breve'));
    assert.equal(options.maxNameLength, 80);
    assert.equal(options.maxRules, 30);
  });

  it('antes de salvar: devolve o padrão com versão 0 e sem data', async () => {
    const config = await json<ConfigDto>(await api('', { cookie: cookieA }));

    assert.equal(config.version, 0);
    assert.equal(config.createdAt, null);
    assert.equal(config.active, true);
    assert.equal(config.tools.includes('base_conhecimento'), true);
    assert.ok(config.name.length > 0);
    assert.ok(config.greeting.length > 0);

    const historico = await json<PageDto>(await api('/versions', { cookie: cookieA }));
    assert.equal(historico.total, 0);
    assert.equal(historico.activeVersion, 0);
    assert.deepEqual(historico.items, []);
  });

  it('salvar cria a versão 1 e ela entra no ar', async () => {
    const response = await api('', {
      cookie: cookieA,
      method: 'PUT',
      body: corpo({ rules: ['Nunca prometa prazo que não está na base.', `${SEGREDO}`] }),
    });
    assert.equal(response.status, 200);

    const salva = await json<ConfigDto>(response);
    assert.equal(salva.version, 1);
    assert.equal(salva.name, 'Bia');
    assert.equal(salva.active, true);
    assert.equal(salva.createdByName, 'Dona A');
    assert.equal(salva.restoredFromVersion, null);
    assert.ok(salva.createdAt);

    const atual = await json<ConfigDto>(await api('', { cookie: cookieA }));
    assert.equal(atual.version, 1);
    assert.deepEqual(atual.rules, ['Nunca prometa prazo que não está na base.', SEGREDO]);
  });

  it('salvar de novo cria a versão 2 e a 1 continua intacta', async () => {
    const v2 = await json<ConfigDto>(
      await api('', {
        cookie: cookieA,
        method: 'PUT',
        body: corpo({ name: 'Bia 2.0', tone: 'formal', rules: [] }),
      }),
    );
    assert.equal(v2.version, 2);
    assert.equal(v2.tone, 'formal');
    assert.deepEqual(v2.rules, []);

    const v1 = await json<ConfigDto>(await api('/versions/1', { cookie: cookieA }));
    assert.equal(v1.name, 'Bia');
    assert.equal(v1.tone, 'amigavel');
    assert.equal(v1.active, false);

    const historico = await json<PageDto>(await api('/versions', { cookie: cookieA }));
    assert.equal(historico.total, 2);
    assert.equal(historico.activeVersion, 2);
    assert.deepEqual(
      historico.items.map((item) => item.version),
      [2, 1],
    );
    assert.equal(historico.items[0]?.active, true);
    assert.equal(historico.items[1]?.active, false);
  });

  it('restaurar a versão 1 cria a versão 3, com a origem registrada', async () => {
    const response = await api('/versions/1/restore', { cookie: cookieA, method: 'POST' });
    assert.equal(response.status, 201);

    const v3 = await json<ConfigDto>(response);
    assert.equal(v3.version, 3);
    assert.equal(v3.restoredFromVersion, 1);
    assert.equal(v3.name, 'Bia');
    assert.equal(v3.tone, 'amigavel');
    assert.equal(v3.active, true);

    const historico = await json<PageDto>(await api('/versions', { cookie: cookieA }));
    assert.deepEqual(
      historico.items.map((item) => item.version),
      [3, 2, 1],
    );
  });

  it('restaurar a versão que já está no ar: 409', async () => {
    const response = await api('/versions/3/restore', { cookie: cookieA, method: 'POST' });
    assert.equal(response.status, 409);
    const { message } = await json<{ message: string }>(response);
    assert.match(message, /já é a que está no ar/i);
  });

  it('versão inexistente: 404 ao ler e ao restaurar', async () => {
    assert.equal((await api('/versions/99', { cookie: cookieA })).status, 404);
    assert.equal(
      (await api('/versions/99/restore', { cookie: cookieA, method: 'POST' })).status,
      404,
    );
  });

  it('versão com formato inválido: 400', async () => {
    for (const path of ['/versions/abc', '/versions/0', '/versions/-1']) {
      assert.equal((await api(path, { cookie: cookieA })).status, 400, path);
    }
  });

  it('corpo inválido: 400 com a mensagem explicando o campo', async () => {
    const casos: [Record<string, unknown>, RegExp][] = [
      [corpo({ name: '' }), /nome/i],
      [corpo({ name: 'x'.repeat(81) }), /name|nome/i],
      [corpo({ tone: 'poeta' }), /tom/i],
      [corpo({ greeting: '   ' }), /apresenta/i],
      [corpo({ tools: ['nao_existe'] }), /não existe/i],
      [corpo({ tools: ['escalar_humano'] }), /ainda não está disponível/i],
      [corpo({ rules: Array.from({ length: 61 }, () => 'regra') }), /rules|regra/i],
      [{ ...corpo(), extra: 'campo a mais' }, /./],
    ];

    for (const [body, esperado] of casos) {
      const response = await api('', { cookie: cookieA, method: 'PUT', body });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      const { message } = await json<{ message: string | string[] }>(response);
      assert.match(Array.isArray(message) ? message.join('; ') : message, esperado);
    }

    // E nada disso criou versão nova.
    const historico = await json<PageDto>(await api('/versions', { cookie: cookieA }));
    assert.equal(historico.total, 3);
  });

  it('espaços sobrando saem e regra vazia é descartada', async () => {
    const salva = await json<ConfigDto>(
      await api('', {
        cookie: cookieA,
        method: 'PUT',
        body: corpo({ name: '  Bia  ', rules: ['  com espaço  ', '', '   '] }),
      }),
    );
    assert.equal(salva.name, 'Bia');
    assert.deepEqual(salva.rules, ['com espaço']);
  });

  it('isolamento: o tenant B tem o próprio histórico e não alcança o do A', async () => {
    const doB = await json<ConfigDto>(await api('', { cookie: cookieB }));
    assert.equal(doB.version, 0, 'B nunca salvou: tem de ver o padrão');

    const salvaB = await json<ConfigDto>(
      await api('', { cookie: cookieB, method: 'PUT', body: corpo({ name: 'Bot do B' }) }),
    );
    assert.equal(salvaB.version, 1, 'a numeração do B começa do 1');

    // As versões do A não existem para o B.
    assert.equal((await api('/versions/4', { cookie: cookieB })).status, 404);
    const historicoB = await json<PageDto>(await api('/versions', { cookie: cookieB }));
    assert.equal(historicoB.total, 1);
    assert.equal(historicoB.items[0]?.name, 'Bot do B');

    // E o A continua vendo o dele.
    const atualA = await json<ConfigDto>(await api('', { cookie: cookieA }));
    assert.equal(atualA.name, 'Bia');
  });

  it('logs e métricas levam o tenant_id — e nunca o conteúdo', async () => {
    const linhas = logs.filter((linha) => linha.includes('agent_config'));
    assert.ok(linhas.length > 0, 'nenhuma linha de log da configuração');

    const salvou = linhas.filter((linha) => linha.includes('agent_config.saved'));
    const restaurou = linhas.filter((linha) => linha.includes('agent_config.restored'));
    assert.ok(salvou.length >= 1 && restaurou.length >= 1);
    for (const linha of [...salvou, ...restaurou]) {
      assert.match(linha, new RegExp(`"tenant_id":"[0-9a-f-]{36}"`));
    }
    assert.match(restaurou.join(''), /"restored_from_version":1/);

    const metricas = logs.filter((linha) => linha.includes('"metric":"agent_config'));
    assert.ok(
      metricas.some(
        (linha) => linha.includes('agent_config_saves_total') && linha.includes(tenantA),
      ),
      'métrica de salvamento sem tenant_id',
    );
    assert.ok(metricas.some((linha) => linha.includes('agent_config_restores_total')));
    assert.ok(
      metricas.some((linha) => linha.includes('"outcome":"rejected"')),
      'as recusas também contam',
    );

    // Privacidade: a regra que o cliente escreveu não pode aparecer em NENHUMA linha.
    assert.equal(
      logs.some((linha) => linha.includes(SEGREDO)),
      false,
      'o conteúdo da configuração vazou para o log',
    );
  });
});
