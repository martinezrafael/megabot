import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentConfigForm } from '../src/components/agent-config-form';
import { AgentVersionHistory } from '../src/components/agent-version-history';
import {
  fetchAgentConfig,
  fetchAgentConfigVersions,
  toneLabel,
  toolLabel,
  versionLabel,
  type AgentConfig,
  type AgentConfigOptions,
} from '../src/lib/agent-config';

const options: AgentConfigOptions = {
  tones: [
    { key: 'formal', label: 'Formal', hint: 'Trata por senhor.' },
    { key: 'amigavel', label: 'Amigável', hint: 'Trata por você.' },
  ],
  tools: [
    {
      key: 'base_conhecimento',
      label: 'Consultar a base de conhecimento',
      description: 'Busca nos conteúdos cadastrados.',
      status: 'disponivel',
    },
    {
      key: 'escalar_humano',
      label: 'Encaminhar para uma pessoa',
      description: 'Passa para o atendimento humano.',
      status: 'em_breve',
    },
  ],
  maxNameLength: 80,
  maxGreetingLength: 1000,
  maxRules: 30,
  maxRuleLength: 500,
};

const versao = (over: Partial<AgentConfig> = {}): AgentConfig => ({
  version: 2,
  name: 'Bia',
  tone: 'amigavel',
  greeting: 'Oi! Eu sou a Bia.',
  tools: ['base_conhecimento'],
  rules: ['Nunca prometa prazo que não está na base.'],
  createdByName: 'Dona A',
  restoredFromVersion: null,
  createdAt: '2026-11-21T12:00:00.000Z',
  active: true,
  ...over,
});

describe('rótulos da configuração do agente', () => {
  it('traduz tom e ferramenta para o que a pessoa lê', () => {
    assert.equal(toneLabel(options.tones, 'amigavel'), 'Amigável');
    assert.equal(toolLabel(options.tools, 'base_conhecimento'), 'Consultar a base de conhecimento');
  });

  it('chave desconhecida aparece como está, em vez de sumir', () => {
    // Acontece quando uma ferramenta sai do catálogo depois de ter sido salva numa versão antiga.
    assert.equal(toolLabel(options.tools, 'ferramenta_aposentada'), 'ferramenta_aposentada');
    assert.equal(toneLabel(options.tones, 'neutro'), 'neutro');
  });

  it('o rótulo da versão mostra de onde ela veio, quando veio de um rollback', () => {
    assert.equal(versionLabel(versao({ version: 4, restoredFromVersion: null })), 'Versão 4');
    assert.equal(
      versionLabel(versao({ version: 4, restoredFromVersion: 1 })),
      'Versão 4 · restaurada da 1',
    );
  });
});

describe('histórico de versões (render)', () => {
  it('sem versões: explica em vez de mostrar tabela vazia', () => {
    const html = renderToStaticMarkup(
      <AgentVersionHistory versions={[]} total={0} activeVersion={0} options={options} />,
    );
    assert.match(html, /Nenhuma versão salva ainda/);
    assert.equal(html.includes('<table'), false);
  });

  it('mostra quem salvou, o tom por extenso e marca a que está no ar', () => {
    const html = renderToStaticMarkup(
      <AgentVersionHistory
        versions={[versao(), versao({ version: 1, active: false, name: 'Bot antigo' })]}
        total={2}
        activeVersion={2}
        options={options}
      />,
    );

    assert.match(html, /Dona A/);
    assert.match(html, /Amigável/);
    assert.match(html, /no ar/);
    assert.match(html, /Bot antigo/);
    // A versão no ar não oferece o botão "Restaurar" (restaurar a ativa é recusado pela API).
    // O texto explicativo no fim também fala em restaurar, por isso a conta é só dos BOTÕES.
    assert.equal(html.match(/>Restaurar<\/button>/g)?.length, 1);
  });

  it('conta removida não deixa a coluna "Quem" vazia', () => {
    const html = renderToStaticMarkup(
      <AgentVersionHistory
        versions={[versao({ createdByName: null })]}
        total={1}
        activeVersion={2}
        options={options}
      />,
    );
    assert.match(html, /conta removida/);
  });
});

describe('leitura da API', () => {
  const base = { apiUrl: 'http://api.test', cookie: 'session=abc' };
  const resposta = (status: number, body: unknown = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('manda o cookie da sessão e devolve os dados', async () => {
    let url = '';
    let cookie = '';
    const result = await fetchAgentConfig({
      ...base,
      fetchImpl: (input, init) => {
        url = String(input);
        cookie = String((init?.headers as Record<string, string>).cookie);
        return Promise.resolve(resposta(200, versao()));
      },
    });

    assert.equal(url, 'http://api.test/agent-config');
    assert.equal(cookie, 'session=abc');
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' ? result.data.version : null, 2);
  });

  it('sessão sem empresa (403) não é erro de tela', async () => {
    const result = await fetchAgentConfig({
      ...base,
      fetchImpl: () => Promise.resolve(resposta(403)),
    });
    assert.equal(result.status, 'forbidden');
  });

  it('o histórico pede a página pedida', async () => {
    let url = '';
    await fetchAgentConfigVersions(
      {
        ...base,
        fetchImpl: (input) => {
          url = String(input);
          return Promise.resolve(resposta(200, { total: 0, activeVersion: 0, items: [] }));
        },
      },
      { limit: 5, offset: 10 },
    );
    assert.equal(url, 'http://api.test/agent-config/versions?limit=5&offset=10');
  });

  it('erro inesperado do servidor sobe como erro', async () => {
    await assert.rejects(
      () => fetchAgentConfig({ ...base, fetchImpl: () => Promise.resolve(resposta(500)) }),
      /500/,
    );
  });
});

describe('formulário do agente (render)', () => {
  it('mostra os valores que vão ser salvos e marca as ferramentas ligadas', () => {
    const html = renderToStaticMarkup(
      <AgentConfigForm config={versao({ version: 3 })} options={options} />,
    );

    assert.match(html, /value="Bia"/);
    assert.match(html, /Oi! Eu sou a Bia\./);
    assert.match(html, /No ar: versão 3/);
    // A regra salva aparece como campo editável.
    assert.match(html, /value="Nunca prometa prazo que não está na base\."/);
  });

  it('ferramenta "em breve" aparece, mas não dá para ligar', () => {
    const html = renderToStaticMarkup(<AgentConfigForm config={versao()} options={options} />);
    const campo = (key: string) =>
      html.match(new RegExp(`<input[^>]*value="${key}"[^>]*>`))?.[0] ?? '';

    assert.match(html, /em breve/);
    assert.match(campo('escalar_humano'), /disabled/);
    // E a que existe de verdade continua ligável.
    assert.doesNotMatch(campo('base_conhecimento'), /disabled/);
  });

  it('sem nada salvo, avisa que são os valores padrão', () => {
    const html = renderToStaticMarkup(
      <AgentConfigForm config={versao({ version: 0, createdAt: null })} options={options} />,
    );
    assert.match(html, /valores padrão/);
  });

  it('sem regras, abre uma linha em branco para começar a digitar', () => {
    const html = renderToStaticMarkup(
      <AgentConfigForm config={versao({ rules: [] })} options={options} />,
    );
    assert.match(html, /aria-label="Regra 1"/);
    assert.match(html, /0 de no máximo 30/);
  });
});
