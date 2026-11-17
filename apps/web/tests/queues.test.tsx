import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { JobsTable, QueuesTable } from '../src/components/queues-table';
import {
  fetchQueueJobs,
  fetchQueues,
  type JobSummary,
  type QueueOverview,
} from '../src/lib/queues';
import { formatDuration, queueHealth } from '../src/lib/queues-format';

const counts = {
  created: 0,
  retry: 0,
  active: 0,
  completed: 0,
  cancelled: 0,
  failed: 0,
  deferred: 0,
};
const queue = (over: Partial<QueueOverview> = {}): QueueOverview => ({
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
  counts,
  oldestWaitingSeconds: null,
  lastCompletedAt: null,
  lastFailedAt: null,
  ...over,
});

describe('formatDuration', () => {
  it('formata segundos, minutos, horas e dias', () => {
    assert.equal(formatDuration(null), '—');
    assert.equal(formatDuration(42), '42 s');
    assert.equal(formatDuration(300), '5 min');
    assert.equal(formatDuration(7800), '2 h 10 min');
    assert.equal(formatDuration(3 * 86400), '3 d');
  });
});

describe('queueHealth (semáforo)', () => {
  it('normal, atenção e falhas', () => {
    assert.equal(queueHealth(queue()), 'ok');
    assert.equal(queueHealth(queue({ counts: { ...counts, retry: 1 } })), 'warning');
    assert.equal(queueHealth(queue({ oldestWaitingSeconds: 301 })), 'warning');
    assert.equal(queueHealth(queue({ oldestWaitingSeconds: 30 })), 'ok');
    assert.equal(queueHealth(queue({ counts: { ...counts, failed: 1 } })), 'danger');
  });
  it('DLQ com jobs é vermelha; DLQ vazia é normal', () => {
    assert.equal(
      queueHealth(queue({ isDeadLetter: true, counts: { ...counts, created: 2 } })),
      'danger',
    );
    assert.equal(queueHealth(queue({ isDeadLetter: true })), 'ok');
  });
});

describe('tabelas', () => {
  it('QueuesTable mostra contagens, DLQ e link para a fila', () => {
    const html = renderToStaticMarkup(
      <QueuesTable
        queues={[
          queue({ counts: { ...counts, created: 3, deferred: 1, completed: 9 } }),
          queue({
            name: 'whatsapp.inbound.dlq',
            isDeadLetter: true,
            counts: { ...counts, created: 2 },
          }),
        ]}
      />,
    );
    assert.match(html, /href="\/admin\/queues\?queue=whatsapp\.inbound"/);
    assert.match(html, /DLQ/);
    assert.match(html, /1 agendados/);
    assert.match(html, /Falhas/);
  });

  it('QueuesTable vazio avisa', () => {
    assert.match(renderToStaticMarkup(<QueuesTable queues={[]} />), /Nenhuma fila/);
  });

  it('JobsTable mostra empresa, origem e erro, e escapa HTML', () => {
    const job: JobSummary = {
      id: '22222222-2222-4222-8222-222222222222',
      queue: 'x.dlq',
      state: 'created',
      tenantId: '11111111-1111-4111-8111-111111111111',
      retryCount: 1,
      retryLimit: 2,
      createdAt: '2026-11-16T12:00:00.000Z',
      startAfter: '2026-11-16T12:00:00.000Z',
      startedAt: null,
      completedAt: null,
      sourceQueue: 'x',
      sourceJobId: '33333333-3333-4333-8333-333333333333',
      errorName: 'Error',
      errorMessage: '<script>alert(1)</script>',
    };
    const html = renderToStaticMarkup(<JobsTable jobs={[job]} />);
    assert.match(html, /22222222/);
    assert.match(html, /11111111/);
    assert.match(html, /Error: &lt;script&gt;/);
    assert.ok(!html.includes('<script>'));
    assert.match(renderToStaticMarkup(<JobsTable jobs={[]} />), /Nenhum job/);
  });
});

describe('fetchQueues / fetchQueueJobs', () => {
  const opts = (res: Response, calls: string[] = []) => ({
    apiUrl: 'http://api',
    cookie: 'c=1',
    fetchImpl: (async (url: string) => {
      calls.push(url);
      return res;
    }) as unknown as typeof fetch,
  });

  it('ok devolve os dados', async () => {
    const result = await fetchQueues(
      opts(Response.json({ installed: true, generatedAt: 'x', queues: [] })),
    );
    assert.equal(result.status, 'ok');
  });
  it('401/403 viram forbidden e 404 vira not_found', async () => {
    assert.equal((await fetchQueues(opts(new Response('', { status: 403 })))).status, 'forbidden');
    assert.equal((await fetchQueues(opts(new Response('', { status: 401 })))).status, 'forbidden');
    assert.equal(
      (await fetchQueueJobs(opts(new Response('', { status: 404 })), 'x')).status,
      'not_found',
    );
  });
  it('erro 500 lança', async () => {
    await assert.rejects(() => fetchQueues(opts(new Response('', { status: 500 }))));
  });
  it('codifica o nome da fila e limita o resultado', async () => {
    const calls: string[] = [];
    await fetchQueueJobs(opts(Response.json([]), calls), 'a b.dlq', 10);
    assert.equal(calls[0], 'http://api/admin/queues/a%20b.dlq/jobs?limit=10');
  });
});
