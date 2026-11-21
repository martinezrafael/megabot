import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS as DIMS,
  createKnowledgeSource,
  finishKnowledgeSourceIngestion,
  listKnowledgeChunks,
  prisma,
  replaceKnowledgeChunks,
} from '@megabot/database';
import { Retriever, loadTokenCounter, type RetrievalResult } from '../src';
import { CORPUS, PERGUNTAS } from './amostras';
import { LexicalEmbeddingProvider, lexicalVector } from './lexical-embedder';

/**
 * Teste de relevância com amostras (T2.3), contra Postgres + pgvector de verdade.
 *
 * Mede o que a gente controla: as perguntas de uma loja recuperam os trechos certos, dentro dos
 * limites, e nunca atravessam a fronteira do tenant. O modelo de embedding aqui é léxico e
 * determinístico (ver lexical-embedder.ts) — a qualidade semântica do provedor real não é o que
 * está sendo medido.
 */

const run = randomUUID().slice(0, 8);
const embedder = new LexicalEmbeddingProvider();

/**
 * Metas de qualidade: se a recuperação piorar, o teste falha e imprime o relatório pergunta a
 * pergunta. As metas ficam ~uma pergunta abaixo do resultado atual (hoje: 87% em 1º lugar e 93%
 * entre os 3 primeiros), para uma mudança pequena não quebrar o CI sem motivo.
 */
const META_TOP1 = 0.75;
const META_RECALL3 = 0.85;

describe('relevância da busca na base (Postgres + pgvector reais)', () => {
  let tenantA = '';
  let tenantB = '';
  /** id do trecho na amostra -> id do trecho no banco */
  const idPorAmostra = new Map<string, string>();
  let retriever: Retriever;

  before(async () => {
    const [a, b] = await Promise.all([
      prisma.tenant.create({ data: { name: 'Loja A', slug: `rel-a-${run}` } }),
      prisma.tenant.create({ data: { name: 'Loja B', slug: `rel-b-${run}` } }),
    ]);
    tenantA = a.id;
    tenantB = b.id;

    // Ingestão da amostra no tenant A, igual ao que o job knowledge.ingest faz.
    for (const fonte of CORPUS) {
      const source = await createKnowledgeSource(tenantA, {
        kind: 'text',
        title: fonte.titulo,
        rawText: fonte.trechos.map((t) => t.texto).join('\n\n'),
      });
      await replaceKnowledgeChunks(
        tenantA,
        source.id,
        fonte.trechos.map((trecho, position) => ({
          position,
          content: trecho.texto,
          heading: trecho.heading,
          embedding: lexicalVector(`${trecho.heading ?? ''} ${trecho.texto}`),
        })),
        'lexical-teste',
      );
      await finishKnowledgeSourceIngestion(tenantA, source.id, {
        checksum: 'amostra',
        charCount: fonte.trechos.reduce((soma, t) => soma + t.texto.length, 0),
        chunkCount: fonte.trechos.length,
        embeddingModel: 'lexical-teste',
        embeddingDimensions: DIMS,
      });

      const gravados = await listKnowledgeChunks(tenantA, source.id);
      fonte.trechos.forEach((trecho, index) => {
        idPorAmostra.set(trecho.id, gravados[index]!.id);
      });
    }

    retriever = new Retriever({ embedder, limits: { minSimilarity: 0.05 } });
  });

  after(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await prisma.$disconnect();
  });

  it('as perguntas da amostra recuperam os trechos esperados', async () => {
    const linhas: Array<{ pergunta: string; posicao: string; similaridade: string }> = [];
    let top1 = 0;
    let recall3 = 0;

    for (const { pergunta, esperado } of PERGUNTAS) {
      const resultado = await retriever.retrieve({ tenantId: tenantA, query: pergunta });
      const esperadoId = idPorAmostra.get(esperado)!;
      const posicao = resultado.chunks.findIndex((c) => c.chunkId === esperadoId);

      if (posicao === 0) top1 += 1;
      if (posicao >= 0 && posicao < 3) recall3 += 1;
      linhas.push({
        pergunta: pergunta.slice(0, 48),
        posicao: posicao < 0 ? 'não achou' : `${posicao + 1}º`,
        similaridade: resultado.chunks[0] ? resultado.chunks[0].similarity.toFixed(2) : '—',
      });
    }

    const taxaTop1 = top1 / PERGUNTAS.length;
    const taxaRecall3 = recall3 / PERGUNTAS.length;
    console.table(linhas);
    console.info(
      `acerto em 1º lugar: ${(taxaTop1 * 100).toFixed(0)}% | entre os 3 primeiros: ${(taxaRecall3 * 100).toFixed(0)}%`,
    );

    assert.ok(
      taxaTop1 >= META_TOP1,
      `acerto em 1º lugar caiu para ${(taxaTop1 * 100).toFixed(0)}%`,
    );
    assert.ok(
      taxaRecall3 >= META_RECALL3,
      `acerto entre os 3 primeiros caiu para ${(taxaRecall3 * 100).toFixed(0)}%`,
    );
  });

  it('a ordem respeita a similaridade e o contexto cita as fontes', async () => {
    const resultado = await retriever.retrieve({
      tenantId: tenantA,
      query: 'Qual o prazo de entrega para o interior do Nordeste?',
    });
    assert.ok(resultado.chunks.length > 0);
    const notas = resultado.chunks.map((c) => c.similarity);
    assert.deepEqual(
      notas,
      [...notas].sort((a, b) => b - a),
      'os trechos devem vir do mais parecido',
    );
    assert.match(resultado.context, /^\[1\] Entrega e frete — Prazos de entrega\n/);
    assert.match(resultado.context, /Capitais recebem em 2 dias úteis/);
    assert.equal(resultado.embeddingModel, 'lexical-teste');
    assert.ok(resultado.latencyMs >= 0);
  });

  it('pergunta fora da base não traz lixo (volta vazio)', async () => {
    const resultado = await retriever.retrieve({
      tenantId: tenantA,
      query: 'Vocês fazem manutenção de turbina de avião a jato?',
      limits: { minSimilarity: 0.3 },
    });
    assert.deepEqual(resultado.chunks, []);
    assert.equal(resultado.context, '');
    assert.ok(resultado.stats.candidates === 0 || resultado.stats.belowThreshold > 0);
  });

  it('limites valem de ponta a ponta: trechos, tokens e diversidade por fonte', async () => {
    const contar = await loadTokenCounter();

    const poucos = await retriever.retrieve({
      tenantId: tenantA,
      query: 'troca devolução frete entrega pagamento atendimento',
      limits: { maxChunks: 2, minSimilarity: 0.01 },
    });
    assert.equal(poucos.chunks.length, 2);

    const apertado = await retriever.retrieve({
      tenantId: tenantA,
      query: 'troca devolução frete entrega pagamento atendimento',
      limits: { maxTokens: 80, maxChunkTokens: 60, minSimilarity: 0.01 },
    });
    assert.ok(apertado.tokens <= 80, `contexto estourou o orçamento: ${apertado.tokens}`);
    assert.equal(contar(apertado.context), apertado.tokens, 'os tokens são contados de verdade');
    assert.ok(apertado.chunks.length >= 1);

    const diverso = await retriever.retrieve({
      tenantId: tenantA,
      query: 'troca frete devolução etiqueta defeito estorno',
      limits: { maxPerSource: 1, maxChunks: 5, minSimilarity: 0.01 },
    });
    const porFonte = new Map<string, number>();
    for (const chunk of diverso.chunks) {
      porFonte.set(chunk.sourceId, (porFonte.get(chunk.sourceId) ?? 0) + 1);
    }
    assert.ok(
      [...porFonte.values()].every((n) => n === 1),
      'no máximo um trecho por fonte',
    );
  });

  it('isolamento: a mesma pergunta no tenant B não devolve nada do tenant A', async () => {
    for (const { pergunta } of PERGUNTAS.slice(0, 4)) {
      const resultado: RetrievalResult = await retriever.retrieve({
        tenantId: tenantB,
        query: pergunta,
        limits: { minSimilarity: 0 },
      });
      assert.deepEqual(resultado.chunks, [], `vazou conteúdo para o tenant B: "${pergunta}"`);
      assert.equal(resultado.context, '');
    }
  });

  it('fonte que ainda não terminou a ingestão não aparece na busca', async () => {
    const rascunho = await createKnowledgeSource(tenantA, {
      kind: 'text',
      title: 'Rascunho ainda processando',
      rawText: 'x',
    });
    await replaceKnowledgeChunks(
      tenantA,
      rascunho.id,
      [
        {
          position: 0,
          content: 'A camiseta preta de algodão custa 79,90 e está em promoção relâmpago.',
          embedding: lexicalVector('camiseta preta algodão preço promoção'),
        },
      ],
      'lexical-teste',
    );

    const resultado = await retriever.retrieve({
      tenantId: tenantA,
      query: 'Quanto custa a camiseta preta de algodão?',
    });
    assert.ok(
      !resultado.chunks.some((c) => c.sourceId === rascunho.id),
      'trecho de fonte não publicada apareceu',
    );
    assert.ok(resultado.chunks.length > 0, 'mas a fonte pronta continua respondendo');
  });
});
