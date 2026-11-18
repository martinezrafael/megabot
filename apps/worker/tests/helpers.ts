import { randomUUID } from 'node:crypto';
import { prisma, registerWhatsappConnection, withTenant } from '@megabot/database';
import type { JobContext, JobHandler, QueueDefinition } from '@megabot/queue';

export const T0 = new Date('2026-11-18T12:00:00.000Z');
export const HOUR = 60 * 60 * 1000;
export const at = (hours: number) => new Date(T0.getTime() + hours * HOUR);

export const run = randomUUID().slice(0, 8);
let seq = 0;
export const nextSeq = () => ++seq;
export const newWaId = () => `5511${String(Date.now()).slice(-5)}${String(++seq).padStart(2, '0')}`;
export const newPhoneNumberId = () => `${Date.now()}${String(++seq).padStart(3, '0')}`;

const tenants: string[] = [];

export async function newTenant(options: { whatsapp?: boolean } = {}) {
  const t = await prisma.tenant.create({
    data: { name: `T16 ${run}`, slug: `t16-${run}-${++seq}` },
  });
  tenants.push(t.id);
  let phoneNumberId: string | undefined;
  if (options.whatsapp !== false) {
    phoneNumberId = newPhoneNumberId();
    await registerWhatsappConnection(t.id, { phoneNumberId, wabaId: `waba-${seq}` });
  }
  return { tenantId: t.id, phoneNumberId };
}

export async function cleanupTenants() {
  await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
  await prisma.$disconnect();
}

export type Fields = Record<string, unknown>;

/** Logger de teste: guarda tudo o que o job registrar. */
export function captureLogger() {
  const logs: Fields[] = [];
  const push = (f: Fields) => void logs.push(f);
  return { logs, logger: { info: push, warn: push, error: push, debug: push } };
}

/** Executa um handler com um contexto de job de mentira. */
export function runJob<D extends QueueDefinition>(
  handler: JobHandler<D>,
  tenantId: string,
  payload: JobContext<D>['payload'],
  over: { attempt?: number; maxAttempts?: number; logger?: ReturnType<typeof captureLogger> } = {},
) {
  const cap = over.logger ?? captureLogger();
  const ctx = {
    jobId: randomUUID(),
    tenantId,
    payload,
    attempt: over.attempt ?? 1,
    maxAttempts: over.maxAttempts ?? 9,
    signal: new AbortController().signal,
    logger: cap.logger as never,
  } as JobContext<D>;
  return { promise: handler(ctx), logs: cap.logs };
}

export const getMessage = (tenantId: string, id: string) =>
  withTenant(tenantId, (tx) => tx.message.findUniqueOrThrow({ where: { id } }));

export const getEvent = (tenantId: string, id: string) =>
  withTenant(tenantId, (tx) => tx.webhookEvent.findUniqueOrThrow({ where: { id } }));

export async function addEvent(
  tenantId: string,
  kind: 'message' | 'status' | 'error',
  payload: Record<string, unknown>,
  receivedAt: Date = T0,
) {
  const e = await withTenant(tenantId, (tx) =>
    tx.webhookEvent.create({
      data: {
        tenantId,
        phoneNumberId: '1',
        eventKey: `${kind}:${randomUUID()}`,
        kind,
        eventAt: T0,
        receivedAt,
        payload: payload as never,
      },
      select: { id: true },
    }),
  );
  return e.id;
}
