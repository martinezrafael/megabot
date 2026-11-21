import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../src/client';
import { withTenant } from '../../src/tenant-helper';
import {
  AGENT_TOOLS,
  AgentConfigAlreadyActiveError,
  AgentConfigInvalidError,
  AgentConfigVersionNotFoundError,
  AgentToolUnavailableError,
  DEFAULT_AGENT_CONFIG,
  UnknownAgentToolError,
  getActiveAgentConfig,
  getActiveAgentConfigOrDefault,
  getAgentConfigVersion,
  listAgentConfigVersions,
  restoreAgentConfigVersion,
  saveAgentConfig,
  type AgentConfigInput,
} from '../../src';

const run = randomUUID().slice(0, 8);

const entrada = (overrides: Partial<AgentConfigInput> = {}): AgentConfigInput => ({
  name: 'Bia',
  tone: 'amigavel',
  greeting: 'Oi! Eu sou a Bia, da Loja Modelo.',
  tools: ['base_conhecimento'],
  rules: ['Nunca prometa prazo que não está na base.'],
  ...overrides,
});

describe('configuração do agente (Postgres real, T2.4)', () => {
  let tenantA = '';
  let tenantB = '';
  let userId = '';

  before(async () => {
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: `Agente A ${run}`, slug: `agente-a-${run}` } }),
      prisma.tenant.create({ data: { name: `Agente B ${run}`, slug: `agente-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;
    const user = await prisma.user.create({
      data: { email: `agente-${run}@teste.local`, name: 'Rafael Teste', emailVerified: true },
    });
    userId = user.id;
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('sem nada salvo: a ativa é nula e o padrão vem com versão 0', async () => {
    assert.equal(await getActiveAgentConfig(tenantA), null);

    const padrao = await getActiveAgentConfigOrDefault(tenantA);
    assert.equal(padrao.version, 0);
    assert.equal(padrao.name, DEFAULT_AGENT_CONFIG.name);
    assert.deepEqual(padrao.tools, DEFAULT_AGENT_CONFIG.tools);
    assert.equal(padrao.createdByName, null);

    // O padrão é uma CÓPIA: mexer no que a função devolveu não contamina a constante.
    padrao.rules.push('regra intrusa');
    assert.equal(DEFAULT_AGENT_CONFIG.rules.includes('regra intrusa'), false);
  });

  it('salvar cria versões 1, 2, 3... e a ativa é sempre a maior', async () => {
    const v1 = await saveAgentConfig(tenantA, entrada(), { userId });
    assert.equal(v1.version, 1);
    assert.equal(v1.createdByUserId, userId);
    assert.equal(v1.createdByName, 'Rafael Teste');
    assert.equal(v1.restoredFromVersion, null);

    const v2 = await saveAgentConfig(tenantA, entrada({ name: 'Bia 2.0', tone: 'formal' }), {
      userId,
    });
    assert.equal(v2.version, 2);

    const ativa = await getActiveAgentConfig(tenantA);
    assert.equal(ativa?.version, 2);
    assert.equal(ativa?.name, 'Bia 2.0');
    assert.equal(ativa?.tone, 'formal');

    // A versão 1 continua intacta: a tabela é append-only.
    const antiga = await getAgentConfigVersion(tenantA, 1);
    assert.equal(antiga.name, 'Bia');
    assert.equal(antiga.tone, 'amigavel');
  });

  it('o histórico vem da mais nova para a mais antiga, com total e versão ativa', async () => {
    const historico = await listAgentConfigVersions(tenantA, { limit: 10 });
    assert.equal(historico.total, 2);
    assert.equal(historico.activeVersion, 2);
    assert.deepEqual(
      historico.items.map((item) => item.version),
      [2, 1],
    );

    const pagina = await listAgentConfigVersions(tenantA, { limit: 1, offset: 1 });
    assert.deepEqual(
      pagina.items.map((item) => item.version),
      [1],
    );
  });

  it('restaurar uma versão antiga cria uma versão NOVA, com a origem registrada', async () => {
    const restaurada = await restoreAgentConfigVersion(tenantA, 1, { userId });

    assert.equal(restaurada.version, 3);
    assert.equal(restaurada.restoredFromVersion, 1);
    // Conteúdo idêntico ao da versão 1.
    assert.equal(restaurada.name, 'Bia');
    assert.equal(restaurada.tone, 'amigavel');
    assert.deepEqual(restaurada.rules, ['Nunca prometa prazo que não está na base.']);

    const ativa = await getActiveAgentConfig(tenantA);
    assert.equal(ativa?.version, 3);

    // E o histórico ficou com as três: nada foi reescrito.
    const historico = await listAgentConfigVersions(tenantA);
    assert.deepEqual(
      historico.items.map((item) => item.version),
      [3, 2, 1],
    );
  });

  it('restaurar a versão que já está no ar é recusado', async () => {
    await assert.rejects(
      () => restoreAgentConfigVersion(tenantA, 3, { userId }),
      AgentConfigAlreadyActiveError,
    );
  });

  it('restaurar versão inexistente é 404 do domínio', async () => {
    await assert.rejects(
      () => restoreAgentConfigVersion(tenantA, 99, { userId }),
      AgentConfigVersionNotFoundError,
    );
    await assert.rejects(() => getAgentConfigVersion(tenantA, 99), AgentConfigVersionNotFoundError);
  });

  it('entrada inválida não chega ao banco', async () => {
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ name: '   ' })),
      AgentConfigInvalidError,
    );
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ greeting: '' })),
      AgentConfigInvalidError,
    );
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ tone: 'poeta' as never })),
      AgentConfigInvalidError,
    );
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ tools: ['ferramenta_que_nao_existe'] })),
      UnknownAgentToolError,
    );
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ rules: Array.from({ length: 31 }, () => 'x') })),
      AgentConfigInvalidError,
    );
  });

  it('ferramenta do catálogo que ainda não existe de verdade não pode ser habilitada', async () => {
    const emBreve = AGENT_TOOLS.find((tool) => tool.status === 'em_breve');
    assert.ok(emBreve, 'o catálogo deveria ter alguma ferramenta "em breve"');
    await assert.rejects(
      () => saveAgentConfig(tenantA, entrada({ tools: [emBreve.key] })),
      AgentToolUnavailableError,
    );
  });

  it('normaliza: tira espaços, descarta regra vazia e não repete ferramenta', async () => {
    const salva = await saveAgentConfig(
      tenantA,
      entrada({
        name: '  Bia  ',
        greeting: '  Olá!  ',
        tools: ['base_conhecimento', 'base_conhecimento'],
        rules: ['  Regra com espaço  ', '', '   '],
      }),
      { userId },
    );
    assert.equal(salva.name, 'Bia');
    assert.equal(salva.greeting, 'Olá!');
    assert.deepEqual(salva.tools, ['base_conhecimento']);
    assert.deepEqual(salva.rules, ['Regra com espaço']);
  });

  it('isolamento: o tenant B não vê nem alcança as versões do tenant A', async () => {
    assert.equal(await getActiveAgentConfig(tenantB), null);
    assert.equal((await listAgentConfigVersions(tenantB)).total, 0);
    await assert.rejects(() => getAgentConfigVersion(tenantB, 1), AgentConfigVersionNotFoundError);

    // E o B tem a sua própria numeração, que começa do 1 de novo.
    const doB = await saveAgentConfig(tenantB, entrada({ name: 'Outro bot' }), { userId });
    assert.equal(doB.version, 1);

    // A RLS também barra a leitura direta por id: o id do A não existe na sessão do B.
    const doA = await getAgentConfigVersion(tenantA, 1);
    const vazio = await withTenant(tenantB, (tx) =>
      tx.agentConfig.findFirst({ where: { id: doA.id } }),
    );
    assert.equal(vazio, null);
  });

  it('salvar em paralelo não cria duas versões com o mesmo número', async () => {
    const antes = (await listAgentConfigVersions(tenantB)).total;
    const quantas = 5;

    await Promise.all(
      Array.from({ length: quantas }, (_, i) =>
        saveAgentConfig(tenantB, entrada({ name: `Paralelo ${i}` }), { userId }),
      ),
    );

    const depois = await listAgentConfigVersions(tenantB, { limit: 100 });
    assert.equal(depois.total, antes + quantas);
    const versoes = depois.items.map((item) => item.version);
    assert.equal(new Set(versoes).size, versoes.length, 'versões repetidas');
    // Sem buracos: a maior é igual ao total.
    assert.equal(Math.max(...versoes), depois.total);
  });
});
