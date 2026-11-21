import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_CHUNK_OPTIONS, chunkText, parseBlocks } from '../src';

const lorem = (words: number, word = 'palavra') =>
  Array.from({ length: words }, (_, i) => `${word}${i}`).join(' ');

describe('divisão em trechos', () => {
  it('texto curto vira um único trecho, sem seção', () => {
    const chunks = chunkText('Entregamos em todo o Brasil.');
    assert.equal(chunks.length, 1);
    assert.deepEqual(chunks[0], {
      position: 0,
      content: 'Entregamos em todo o Brasil.',
      heading: null,
      charCount: 'Entregamos em todo o Brasil.'.length,
    });
  });

  it('cada trecho leva o título da sua seção e seções não se misturam', () => {
    const chunks = chunkText(
      [
        '# Loja Exemplo',
        '',
        'Somos uma loja de roupas.',
        '',
        '## Entrega',
        '',
        'Capitais em 2 dias.',
        '',
        '## Trocas',
        '',
        'Em até 30 dias.',
      ].join('\n'),
    );
    assert.deepEqual(
      chunks.map((c) => c.heading),
      ['Loja Exemplo', 'Entrega', 'Trocas'],
    );
    assert.equal(chunks[1]?.content, 'Entrega\n\nCapitais em 2 dias.');
    assert.ok(!chunks[1]?.content.includes('loja de roupas'));
  });

  it('nenhum trecho passa do limite, mesmo com parágrafo gigante sem pontuação', () => {
    const text = [
      '## Seção A',
      '',
      lorem(400),
      '',
      lorem(50),
      '',
      '## Seção B',
      '',
      'x'.repeat(5000),
    ].join('\n');
    const chunks = chunkText(text, { maxChars: 500, overlapChars: 50 });
    assert.ok(chunks.length > 5);
    for (const chunk of chunks) {
      assert.ok(chunk.content.length <= 500, `trecho com ${chunk.content.length} caracteres`);
      assert.ok(chunk.content.trim().length > 0);
    }
    assert.deepEqual(
      chunks.map((c) => c.position),
      chunks.map((_, i) => i),
    );
  });

  it('trechos vizinhos se sobrepõem um pouco (contexto não se perde no corte)', () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Parágrafo ${i} com algum texto aqui.`);
    const chunks = chunkText(paragraphs.join('\n\n'), { maxChars: 200, overlapChars: 60 });
    assert.ok(chunks.length >= 3);
    const tail = chunks[0]!.content.slice(-40);
    assert.ok(
      chunks[1]!.content.includes(tail.split(' ').slice(-3).join(' ')),
      'o começo do segundo trecho deveria repetir o fim do primeiro',
    );
  });

  it('sem sobreposição quando overlapChars é 0', () => {
    const chunks = chunkText(
      Array.from({ length: 6 }, (_, i) => `Bloco ${i} ${lorem(20)}`).join('\n\n'),
      { maxChars: 300, overlapChars: 0 },
    );
    assert.ok(chunks.length > 1);
    assert.ok(!chunks[1]!.content.startsWith('Bloco 0'));
  });

  it('junta um último trecho curto no anterior (quando couber e for da mesma seção)', () => {
    const chunks = chunkText(['## S', '', lorem(30), '', 'Fim.'].join('\n'), {
      maxChars: 1200,
      minChars: 200,
    });
    assert.equal(chunks.length, 1);
    assert.match(chunks[0]!.content, /Fim\.$/);
  });

  it('é determinístico: o mesmo texto gera exatamente os mesmos trechos', () => {
    const text = ['# T', '', lorem(300), '', '## S2', '', lorem(300)].join('\n');
    assert.deepEqual(chunkText(text), chunkText(text));
  });

  it('listas e tabelas (linhas seguidas) ficam no mesmo trecho', () => {
    const chunks = chunkText(
      ['## Entrega', '', '- Capitais: 2 dias', '- Interior: 5 dias', '- Exterior: 20 dias'].join(
        '\n',
      ),
    );
    assert.equal(chunks.length, 1);
    assert.equal(
      chunks[0]?.content,
      'Entrega\n\n- Capitais: 2 dias\n- Interior: 5 dias\n- Exterior: 20 dias',
    );
  });

  it('texto vazio ou só espaços não gera trecho', () => {
    assert.deepEqual(chunkText(''), []);
    assert.deepEqual(chunkText('   \n\n  \t '), []);
    assert.deepEqual(chunkText('## Só um título'), []);
  });

  it('opções fora de faixa são ajustadas em vez de quebrar', () => {
    const chunks = chunkText(lorem(200), { maxChars: 10, overlapChars: 9999 });
    assert.ok(chunks.every((c) => c.content.length <= 100));
    assert.ok(chunks.length > 1);
  });

  it('parseBlocks separa parágrafos e guarda a seção de cada um', () => {
    const blocks = parseBlocks(
      ['# A', '', 'um', 'continuação', '', 'dois', '', '## B', '', 'três'].join('\n'),
    );
    assert.deepEqual(blocks, [
      { heading: 'A', text: 'um\ncontinuação' },
      { heading: 'A', text: 'dois' },
      { heading: 'B', text: 'três' },
    ]);
  });

  it('o padrão (1200/150) divide um documento real em trechos de tamanho razoável', () => {
    const doc = Array.from(
      { length: 20 },
      (_, i) => `## Seção ${i}\n\n${lorem(120)}\n\n${lorem(80)}`,
    ).join('\n\n');
    const chunks = chunkText(doc);
    assert.ok(chunks.length >= 20);
    const average = chunks.reduce((sum, c) => sum + c.charCount, 0) / chunks.length;
    assert.ok(average > 400, `média baixa: ${average}`);
    assert.ok(chunks.every((c) => c.charCount <= DEFAULT_CHUNK_OPTIONS.maxChars));
  });
});
