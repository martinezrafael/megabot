import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  EXPIRING_SOON_MS,
  WINDOW_MS,
  WindowClosedError,
  canAdvanceStatus,
  canSendFreeform,
  computeWindowExpiry,
  conversationState,
  isWindowOpen,
  planInboundWindow,
  remainingMs,
  type ExistingConversation,
} from '../src/conversations/window';

const T0 = new Date('2026-11-17T12:00:00.000Z');
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const H = 60 * 60 * 1000;

const conv = (start: Date, over: Partial<ExistingConversation> = {}): ExistingConversation => ({
  id: 'c1',
  status: 'open',
  windowStartedAt: start,
  windowExpiresAt: plus(start, WINDOW_MS),
  lastInboundAt: start,
  ...over,
});

describe('janela de 24h: cálculo', () => {
  it('vence 24h depois da mensagem recebida', () => {
    assert.equal(computeWindowExpiry(T0).toISOString(), '2026-11-18T12:00:00.000Z');
  });

  it('limite exato: 1 ms antes está aberta; no instante exato já está fechada', () => {
    const expires = computeWindowExpiry(T0);
    assert.equal(isWindowOpen(expires, plus(expires, -1)), true);
    assert.equal(isWindowOpen(expires, expires), false);
    assert.equal(isWindowOpen(expires, plus(expires, 1)), false);
  });

  it('estados: active, expiring (última hora) e expired', () => {
    const w = { status: 'open' as const, windowExpiresAt: computeWindowExpiry(T0) };
    assert.equal(conversationState(w, plus(T0, 1 * H)), 'active');
    assert.equal(conversationState(w, plus(T0, 23 * H - 1)), 'active');
    assert.equal(conversationState(w, plus(T0, 23 * H)), 'expiring');
    assert.equal(conversationState(w, plus(T0, 24 * H - 1)), 'expiring');
    assert.equal(conversationState(w, plus(T0, 24 * H)), 'expired');
    assert.equal(EXPIRING_SOON_MS, H);
  });

  it('status expired no banco é expired mesmo com prazo no futuro', () => {
    assert.equal(
      conversationState({ status: 'expired', windowExpiresAt: plus(T0, H) }, T0),
      'expired',
    );
  });

  it('tempo restante e permissão de envio livre', () => {
    const w = { status: 'open' as const, windowExpiresAt: computeWindowExpiry(T0) };
    assert.equal(remainingMs(w, plus(T0, 20 * H)), 4 * H);
    assert.equal(remainingMs(w, plus(T0, 25 * H)), 0);
    assert.equal(canSendFreeform(w, plus(T0, 23 * H)), true);
    assert.equal(canSendFreeform(w, plus(T0, 24 * H)), false);
    assert.equal(canSendFreeform(null, T0), false);
  });

  it('WindowClosedError é definitivo (não repetível) e compatível com a categoria da Meta', () => {
    const e = new WindowClosedError('c');
    assert.equal(e.retryable, false);
    assert.equal(e.category, 'window_expired');
    assert.equal(e.code, 'window_expired');
  });
});

describe('planInboundWindow', () => {
  it('sem janela: abre uma nova começando na mensagem', () => {
    const plan = planInboundWindow({ at: T0, now: T0, open: null, coveringExpired: null });
    assert.equal(plan.action, 'open');
    if (plan.action !== 'open') return;
    assert.equal(plan.next.windowStartedAt.getTime(), T0.getTime());
    assert.equal(plan.next.windowExpiresAt.getTime(), plus(T0, WINDOW_MS).getTime());
    assert.equal(plan.expireOpenId, undefined);
  });

  it('com janela aberta: renova (desliza) e NÃO abre outra', () => {
    const open = conv(T0);
    const at = plus(T0, 10 * H);
    const plan = planInboundWindow({ at, now: at, open, coveringExpired: null });
    assert.equal(plan.action, 'renew');
    if (plan.action !== 'renew') return;
    assert.equal(plan.extended, true);
    assert.equal(plan.next.windowExpiresAt.getTime(), plus(at, WINDOW_MS).getTime());
    assert.equal(plan.next.windowStartedAt.getTime(), T0.getTime());
    assert.equal(plan.next.lastInboundAt.getTime(), at.getTime());
  });

  it('mensagem exatamente no vencimento NÃO renova: expira a antiga e abre outra', () => {
    const open = conv(T0);
    const at = open.windowExpiresAt;
    const plan = planInboundWindow({ at, now: at, open, coveringExpired: null });
    assert.equal(plan.action, 'open');
    if (plan.action !== 'open') return;
    assert.equal(plan.expireOpenId, 'c1');
    assert.equal(plan.next.windowStartedAt.getTime(), at.getTime());
  });

  it('1 ms antes do vencimento ainda renova', () => {
    const open = conv(T0);
    const at = plus(open.windowExpiresAt, -1);
    assert.equal(planInboundWindow({ at, now: at, open, coveringExpired: null }).action, 'renew');
  });

  it('chegada fora de ordem: mensagem mais antiga que a janela recua o início e não encurta o prazo', () => {
    const open = conv(T0);
    const at = plus(T0, -2 * H);
    const plan = planInboundWindow({ at, now: plus(T0, H), open, coveringExpired: null });
    assert.equal(plan.action, 'renew');
    if (plan.action !== 'renew') return;
    assert.equal(plan.extended, false);
    assert.equal(plan.next.windowStartedAt.getTime(), at.getTime());
    assert.equal(plan.next.windowExpiresAt.getTime(), open.windowExpiresAt.getTime());
    assert.equal(plan.next.lastInboundAt.getTime(), T0.getTime());
  });

  it('mensagem atrasada de janela já expirada: só anexa', () => {
    const old = conv(plus(T0, -48 * H), { status: 'expired' });
    const at = plus(T0, -40 * H);
    const plan = planInboundWindow({ at, now: T0, open: null, coveringExpired: old });
    assert.equal(plan.action, 'attach_expired');
  });

  it('mensagem atrasada tem prioridade sobre a janela aberta atual (não a puxa para a janela errada)', () => {
    const old = conv(plus(T0, -48 * H), { id: 'old', status: 'expired' });
    const open = conv(plus(T0, -1 * H));
    const at = plus(T0, -40 * H);
    const plan = planInboundWindow({ at, now: T0, open, coveringExpired: old });
    assert.equal(plan.action, 'attach_expired');
    if (plan.action === 'attach_expired') assert.equal(plan.target.id, 'old');
  });

  it('mensagem muito antiga sem registro: nasce expirada (não conta cota)', () => {
    const at = plus(T0, -30 * H);
    const plan = planInboundWindow({ at, now: T0, open: null, coveringExpired: null });
    assert.equal(plan.action, 'open_expired');
    if (plan.action !== 'open_expired') return;
    assert.equal(plan.next.status, 'expired');
  });
});

describe('status só avança', () => {
  it('permite avanços e bloqueia regressões', () => {
    assert.equal(canAdvanceStatus('queued', 'sent'), true);
    assert.equal(canAdvanceStatus('sent', 'delivered'), true);
    assert.equal(canAdvanceStatus('delivered', 'read'), true);
    assert.equal(canAdvanceStatus('sent', 'read'), true, 'read antes de delivered');
    assert.equal(canAdvanceStatus('read', 'delivered'), false);
    assert.equal(canAdvanceStatus('read', 'sent'), false);
    assert.equal(canAdvanceStatus('delivered', 'failed'), false);
    assert.equal(canAdvanceStatus('failed', 'sent'), false);
    assert.equal(canAdvanceStatus('sent', 'sent'), false);
    assert.equal(canAdvanceStatus('sent', 'failed'), true);
  });
});
