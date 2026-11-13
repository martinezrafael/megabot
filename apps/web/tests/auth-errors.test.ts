import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authErrorMessage } from '../src/lib/auth-errors';

describe('authErrorMessage', () => {
  it('traduz códigos conhecidos', () => {
    assert.equal(
      authErrorMessage({ code: 'INVALID_EMAIL_OR_PASSWORD' }),
      'E-mail ou senha incorretos.',
    );
    assert.match(authErrorMessage({ code: 'EMAIL_NOT_VERIFIED' }) ?? '', /Confirme seu e-mail/);
  });

  it('usa mensagem genérica para códigos desconhecidos e null quando não há erro', () => {
    assert.equal(authErrorMessage({ code: 'ALGO_NOVO' }), 'Algo deu errado. Tente novamente.');
    assert.equal(authErrorMessage(null), null);
  });
});
