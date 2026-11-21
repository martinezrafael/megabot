import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { generateOpenApiSpec } from '../src/openapi-spec';

describe('Contrato OpenAPI', () => {
  it('descreve as rotas da aplicação com respostas e erros tipados', async () => {
    const spec = await generateOpenApiSpec();

    assert.equal(spec.openapi.startsWith('3.'), true);
    for (const route of [
      '/health',
      '/health/ready',
      '/me',
      '/webhooks/whatsapp',
      '/admin/queues',
      '/admin/queues/{name}/jobs',
      '/admin/whatsapp/connections',
      '/knowledge/limits',
      '/knowledge/sources',
      '/knowledge/sources/upload',
      '/knowledge/sources/{id}',
      '/knowledge/sources/{id}/reingest',
      '/knowledge/sources/{id}/chunks',
      '/knowledge/chunks/{chunkId}',
      '/agent-config',
      '/agent-config/options',
      '/agent-config/versions',
      '/agent-config/versions/{version}',
      '/agent-config/versions/{version}/restore',
    ]) {
      assert.ok(spec.paths[route], `${route} ausente no contrato`);
    }

    const me = spec.paths['/me']?.get;
    assert.ok(me?.responses['200'] && me.responses['401'] && me.responses['429']);
    assert.deepEqual(
      Object.keys(spec.components?.schemas ?? {})
        .filter((n) => n.endsWith('Dto'))
        .sort(),
      [
        'AgentConfigDto',
        'AgentConfigOptionsDto',
        'AgentConfigVersionPageDto',
        'AgentToneOptionDto',
        'AgentToolOptionDto',
        'ConnectWhatsappNumberBodyDto',
        'ConnectWhatsappNumberResponseDto',
        'CreateKnowledgeSourceBodyDto',
        'ErrorResponseDto',
        'JobSummaryDto',
        'KnowledgeChunkDto',
        'KnowledgeChunkPageDto',
        'KnowledgeLimitsDto',
        'KnowledgeSourceDto',
        'LivenessResponseDto',
        'MeResponseDto',
        'MeTenantDto',
        'MeUserDto',
        'QueueConfigDto',
        'QueueCountsDto',
        'QueueOverviewDto',
        'QueuesSnapshotDto',
        'ReadinessResponseDto',
        'SaveAgentConfigBodyDto',
        'UpdateKnowledgeChunkBodyDto',
        'WebhookAckDto',
        'WhatsappConnectionDto',
      ],
    );
  });

  it('inclui as rotas de autenticação suportadas e nenhuma outra', async () => {
    const spec = await generateOpenApiSpec();
    const authPaths = Object.keys(spec.paths).filter((p) => p.startsWith('/api/auth/'));

    for (const expected of [
      'sign-up/email',
      'sign-in/email',
      'sign-in/social',
      'sign-out',
      'get-session',
    ]) {
      assert.ok(authPaths.includes(`/api/auth/${expected}`), `${expected} ausente`);
    }
    assert.ok(
      !authPaths.includes('/api/auth/delete-user'),
      'rota não habilitada não deve ser documentada',
    );
  });

  it('openapi.json versionado está ATUALIZADO (rode: pnpm openapi:generate)', async () => {
    const generated = await generateOpenApiSpec();
    const committed = JSON.parse(
      await readFile(path.resolve(__dirname, '../openapi.json'), 'utf8'),
    );

    assert.deepEqual(
      committed,
      JSON.parse(JSON.stringify(generated)),
      'openapi.json desatualizado: rode "pnpm openapi:generate" e faça commit',
    );
  });
});
