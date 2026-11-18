import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideAgentTrigger, type AgentDecisionInput } from '../src/conversations/agent-decision';

const ok: AgentDecisionInput = {
  tenantStatus: 'active',
  messageType: 'text',
  windowOpen: true,
  quotaLimit: 10,
  quotaPosition: 1,
};
const decide = (over: Partial<AgentDecisionInput> = {}) => decideAgentTrigger({ ...ok, ...over });

describe('decideAgentTrigger (regra pura)', () => {
  it('tudo em ordem: aciona', () => {
    assert.deepEqual(decide(), { trigger: true, reason: 'ok' });
  });

  it('tenant que não está ativo: não aciona', () => {
    assert.deepEqual(decide({ tenantStatus: 'suspended' }), {
      trigger: false,
      reason: 'tenant_inactive',
    });
    assert.equal(decide({ tenantStatus: 'missing' }).reason, 'tenant_inactive');
  });

  it('janela vencida: não aciona', () => {
    assert.equal(decide({ windowOpen: false }).reason, 'window_expired');
  });

  it('só texto, botão e resposta interativa acionam', () => {
    for (const messageType of ['text', 'interactive', 'button']) {
      assert.equal(decide({ messageType }).trigger, true, messageType);
    }
    for (const messageType of [
      'image',
      'audio',
      'video',
      'document',
      'sticker',
      'location',
      'reaction',
      'unknown',
    ]) {
      assert.equal(decide({ messageType }).reason, 'unsupported_type', messageType);
    }
  });

  describe('cota', () => {
    it('sem limite (null): nunca bloqueia, mesmo na posição 1000', () => {
      assert.equal(decide({ quotaLimit: null, quotaPosition: 1000 }).trigger, true);
    });

    it('posição igual ao limite ainda é atendida; a seguinte é bloqueada', () => {
      assert.equal(decide({ quotaLimit: 5, quotaPosition: 5 }).trigger, true);
      assert.deepEqual(decide({ quotaLimit: 5, quotaPosition: 6 }), {
        trigger: false,
        reason: 'quota_exceeded',
      });
    });

    it('limite 0 bloqueia tudo', () => {
      assert.equal(decide({ quotaLimit: 0, quotaPosition: 1 }).reason, 'quota_exceeded');
    });
  });

  it('ordem dos motivos: tenant > janela > tipo > cota', () => {
    const all = {
      tenantStatus: 'suspended',
      windowOpen: false,
      messageType: 'image',
      quotaLimit: 0,
      quotaPosition: 9,
    };
    assert.equal(decide(all).reason, 'tenant_inactive');
    assert.equal(decide({ ...all, tenantStatus: 'active' }).reason, 'window_expired');
    assert.equal(
      decide({ ...all, tenantStatus: 'active', windowOpen: true }).reason,
      'unsupported_type',
    );
    assert.equal(
      decide({ ...all, tenantStatus: 'active', windowOpen: true, messageType: 'text' }).reason,
      'quota_exceeded',
    );
  });
});
