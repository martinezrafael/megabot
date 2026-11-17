import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { JobSummary, ListJobsOptions, QueuesSnapshot } from '@megabot/queue';
import type { QueueInspectorPort } from '../src/admin/admin-queues.service';
import { signUpVerified, startTestApp, type TestApp } from './helpers';

const TENANT = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-16T12:00:00.000Z');

/** Inspetor falso: o teste cobre autorização, validação e formato, sem depender do pg-boss. */
function fakeInspector(calls: ListJobsOptions[]): QueueInspectorPort {
  const snapshot: QueuesSnapshot = {
    installed: true,
    generatedAt: NOW,
    queues: [
      {
        name: 'whatsapp.inbound',
        isDeadLetter: false,
        deadLetterName: 'whatsapp.inbound.dlq',
        config: {
          retryLimit: 6,
          retryDelaySeconds: 5,
          retryBackoff: true,
          retryDelayMaxSeconds: 600,
          expireInSeconds: 120,
        },
        counts: {
          created: 3,
          retry: 1,
          active: 0,
          completed: 10,
          cancelled: 0,
          failed: 2,
          deferred: 0,
        },
        oldestWaitingSeconds: 42,
        lastCompletedAt: NOW,
        lastFailedAt: null,
      },
    ],
  };
  const job: JobSummary = {
    id: '22222222-2222-4222-8222-222222222222',
    queue: 'whatsapp.inbound.dlq',
    state: 'created',
    tenantId: TENANT,
    retryCount: 0,
    retryLimit: 2,
    createdAt: NOW,
    startAfter: NOW,
    startedAt: null,
    completedAt: null,
    sourceQueue: 'whatsapp.inbound',
    sourceJobId: '33333333-3333-4333-8333-333333333333',
    errorName: 'Error',
    errorMessage: 'falhou',
  };
  return {
    overview: async () => snapshot,
    queueExists: async (name) => name.startsWith('whatsapp.'),
    listJobs: async (options) => {
      calls.push(options);
      return [job];
    },
    close: async () => undefined,
  };
}

describe('Admin: tela de filas (T1.3)', () => {
  let t: TestApp;
  const calls: ListJobsOptions[] = [];
  let adminCookie: string;
  let memberCookie: string;

  before(async () => {
    t = await startTestApp({
      queueInspector: fakeInspector(calls),
      platformAdminLabels: ['plataforma'],
    });
    adminCookie = await signUpVerified(t, t.newEmail('plataforma'), 'Admin Plataforma');
    memberCookie = await signUpVerified(t, t.newEmail('cliente'), 'Cliente');
  });
  after(async () => {
    await t.close();
  });

  it('sem sessão: 401', async () => {
    assert.equal((await t.api('/admin/queues')).status, 401);
    assert.equal((await t.api('/admin/queues/whatsapp.inbound/jobs')).status, 401);
  });

  it('usuário comum (mesmo sendo OWNER da própria empresa): 403', async () => {
    const res = await t.api('/admin/queues', { cookie: memberCookie });
    assert.equal(res.status, 403);
    assert.equal(
      ((await res.json()) as { message: string }).message,
      'Acesso restrito a administradores da plataforma',
    );
    assert.equal(
      (await t.api('/admin/queues/whatsapp.inbound/jobs', { cookie: memberCookie })).status,
      403,
    );
  });

  it('/me informa platformAdmin', async () => {
    const admin = (await (await t.api('/me', { cookie: adminCookie })).json()) as {
      platformAdmin: boolean;
    };
    const member = (await (await t.api('/me', { cookie: memberCookie })).json()) as {
      platformAdmin: boolean;
    };
    assert.equal(admin.platformAdmin, true);
    assert.equal(member.platformAdmin, false);
  });

  it('administrador da plataforma vê o resumo das filas (datas em ISO, sem cache)', async () => {
    const res = await t.api('/admin/queues', { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = (await res.json()) as {
      installed: boolean;
      generatedAt: string;
      queues: Array<{ name: string; counts: { failed: number }; lastCompletedAt: string | null }>;
    };
    assert.equal(body.installed, true);
    assert.equal(body.generatedAt, NOW.toISOString());
    assert.equal(body.queues[0]?.name, 'whatsapp.inbound');
    assert.equal(body.queues[0]?.counts.failed, 2);
    assert.equal(body.queues[0]?.lastCompletedAt, NOW.toISOString());
  });

  it('lista os jobs de uma fila repassando os filtros validados', async () => {
    calls.length = 0;
    const res = await t.api(
      `/admin/queues/whatsapp.inbound.dlq/jobs?state=created&tenantId=${TENANT}&limit=10`,
      { cookie: adminCookie },
    );
    assert.equal(res.status, 200);
    const [job] = (await res.json()) as Array<{
      id: string;
      createdAt: string;
      errorMessage: string;
    }>;
    assert.equal(job?.createdAt, NOW.toISOString());
    assert.equal(job?.errorMessage, 'falhou');
    assert.deepEqual(calls[0], {
      queue: 'whatsapp.inbound.dlq',
      state: 'created',
      tenantId: TENANT,
      limit: 10,
    });
  });

  it('aplica limit padrão 25 e rejeita filtros inválidos com 400', async () => {
    calls.length = 0;
    await t.api('/admin/queues/whatsapp.inbound/jobs', { cookie: adminCookie });
    assert.equal(calls[0]?.limit, 25);

    for (const query of [
      'state=voando',
      'limit=0',
      'limit=101',
      'limit=abc',
      'tenantId=nao-uuid',
    ]) {
      const res = await t.api(`/admin/queues/whatsapp.inbound/jobs?${query}`, {
        cookie: adminCookie,
      });
      assert.equal(res.status, 400, query);
    }
  });

  it('fila inexistente: 404', async () => {
    const res = await t.api('/admin/queues/outra.fila/jobs', { cookie: adminCookie });
    assert.equal(res.status, 404);
  });
});

describe('Admin: sem administradores configurados', () => {
  it('ninguém acessa (lista vazia = fechado)', async () => {
    const t = await startTestApp({ queueInspector: fakeInspector([]) });
    try {
      const cookie = await signUpVerified(t, t.newEmail('qualquer'));
      assert.equal((await t.api('/admin/queues', { cookie })).status, 403);
    } finally {
      await t.close();
    }
  });
});
