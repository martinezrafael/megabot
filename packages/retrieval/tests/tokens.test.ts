import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateTokens, loadTokenCounter, truncateToTokens } from '../src';

const FRASE = 'Entregamos em todo o Brasil; capitais em 2 dias úteis e interior em até 5 dias.';

describe('contagem de tokens', () => {
  it('conta de verdade (tokenizador), não por caracteres', async () => {
    const count = await loadTokenCounter();
    const tokens = count(FRASE);
    // Em português, o tokenizador fica perto de 3,5 caracteres por token.
    assert.ok(tokens > 0);
    assert.ok(
      tokens > FRASE.length / 5 && tokens < FRASE.length / 2,
      `contagem fora do esperado: ${tokens} tokens para ${FRASE.length} caracteres`,
    );
    assert.equal(count(''), 0);
    assert.ok(count('a') >= 1);
    // Texto maior tem mais tokens; o mesmo texto conta sempre igual.
    assert.ok(count(FRASE.repeat(3)) > tokens * 2.5);
    assert.equal(count(FRASE), tokens);
  });

  it('cada codificação conta do seu jeito e o contador é reaproveitado', async () => {
    const [a, b] = await Promise.all([
      loadTokenCounter('o200k_base'),
      loadTokenCounter('cl100k_base'),
    ]);
    assert.ok(a(FRASE) > 0 && b(FRASE) > 0);
    // cl100k (modelos antigos) costuma gastar mais tokens em português que o200k.
    assert.ok(b(FRASE) >= a(FRASE));
    assert.equal(await loadTokenCounter('o200k_base'), a, 'deveria devolver o mesmo contador');
  });

  it('a estimativa de reserva nunca fica muito abaixo do real', async () => {
    const count = await loadTokenCounter();
    for (const texto of [
      FRASE,
      'Olá! Tudo bem? 😊',
      'SKU: CAM-001 | Nome: Camiseta preta | Preço: 79.9',
      'https://loja.exemplo.com.br/minha-conta/pedidos',
      'a',
    ]) {
      assert.ok(
        estimateTokens(texto) >= count(texto) * 0.8,
        `estimativa baixa demais para "${texto.slice(0, 30)}": ${estimateTokens(texto)} vs ${count(texto)}`,
      );
    }
  });
});

describe('corte por tokens', () => {
  it('texto que cabe não é tocado', async () => {
    const count = await loadTokenCounter();
    const result = truncateToTokens(FRASE, 100, count);
    assert.equal(result.text, FRASE);
    assert.equal(result.truncated, false);
    assert.equal(result.tokens, count(FRASE));
  });

  it('texto grande é cortado dentro do limite, de preferência no fim de uma frase', async () => {
    const count = await loadTokenCounter();
    const longo = [
      'A troca pode ser feita em até 30 dias.',
      'O frete da primeira troca é por nossa conta.',
      'Produtos em promoção também podem ser trocados.',
      'A etiqueta precisa estar intacta.',
    ].join(' ');

    const result = truncateToTokens(longo, 15, count);
    assert.equal(result.truncated, true);
    assert.ok(result.tokens <= 15, `passou do limite: ${result.tokens}`);
    assert.ok(result.text.endsWith('…'));
    assert.ok(longo.startsWith(result.text.slice(0, -1).trimEnd()), 'o corte deve manter o começo');
    // Não corta no meio de uma palavra.
    assert.ok(!/\w…$/.test(result.text) || result.text.slice(0, -1).endsWith('.'));
  });

  it('limite minúsculo ainda devolve algo válido', async () => {
    const count = await loadTokenCounter();
    const result = truncateToTokens(FRASE, 1, count);
    assert.equal(result.truncated, true);
    assert.ok(result.tokens <= 2, `tokens: ${result.tokens}`);
  });

  it('funciona com qualquer contador injetado (ex.: a estimativa)', () => {
    const result = truncateToTokens('x'.repeat(300), 10, estimateTokens);
    assert.equal(result.truncated, true);
    assert.ok(estimateTokens(result.text) <= 10);
  });
});
