import { createHash } from 'node:crypto';
import type { EmbedRequest, EmbedResult, EmbeddingProvider } from '@megabot/ai';
import { KNOWLEDGE_EMBEDDING_DIMENSIONS } from '@megabot/database';

/**
 * Embedding LÉXICO e determinístico, só para os testes de relevância.
 *
 * Por que não usar o provedor de verdade: ele exige chave, rede e custa dinheiro — e o teste ficaria
 * instável (o modelo muda). Por que não usar vetores aleatórios (o `FakeEmbeddingProvider`): aleatório
 * não tem significado nenhum, então não dá para afirmar nada sobre relevância.
 *
 * Este aqui fica no meio: transforma o texto em um vetor de frequência de palavras (sem acento, sem
 * palavras-vazias, com os radicais cortados em 6 letras) espalhado nas 1536 dimensões do banco. Duas
 * frases que falam das MESMAS coisas ficam próximas; frases sobre assuntos diferentes ficam distantes.
 *
 * O que isto testa de verdade: a nossa parte (ordenação por similaridade, limiar, diversidade por
 * fonte, orçamento de tokens, isolamento por tenant). A qualidade semântica do modelo de verdade é
 * outra conversa — essa só o provedor real responde.
 */

/** Palavras que aparecem em tudo e não ajudam a distinguir assunto. */
const VAZIAS = new Set([
  'a',
  'ao',
  'aos',
  'as',
  'ate',
  'com',
  'como',
  'da',
  'das',
  'de',
  'do',
  'dos',
  'e',
  'em',
  'entre',
  'era',
  'essa',
  'esse',
  'esta',
  'este',
  'eu',
  'foi',
  'ha',
  'isso',
  'ja',
  'la',
  'mais',
  'mas',
  'me',
  'mesmo',
  'meu',
  'minha',
  'muito',
  'na',
  'nao',
  'nas',
  'no',
  'nos',
  'o',
  'os',
  'ou',
  'para',
  'pela',
  'pelo',
  'por',
  'qual',
  'quais',
  'quando',
  'quanto',
  'que',
  'se',
  'sem',
  'ser',
  'seu',
  'sua',
  'tem',
  'ter',
  'um',
  'uma',
  'voce',
  'voces',
  'vcs',
  'sobre',
  'tambem',
  'pode',
  'posso',
]);

const semAcento = (texto: string) => texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Palavras úteis do texto, já reduzidas ao radical (6 letras) — "entregamos" e "entrega" viram "entreg". */
export function palavrasRelevantes(texto: string): string[] {
  return semAcento(texto)
    .split(/[^a-z0-9]+/)
    .filter((palavra) => palavra.length > 2 && !VAZIAS.has(palavra))
    .map((palavra) => (/^\d+$/.test(palavra) ? palavra : palavra.slice(0, 6)));
}

export function lexicalVector(
  texto: string,
  dimensions = KNOWLEDGE_EMBEDDING_DIMENSIONS,
): number[] {
  const vetor = new Array<number>(dimensions).fill(0);
  for (const palavra of palavrasRelevantes(texto)) {
    // Cada palavra ocupa sempre a mesma posição (hash estável) e soma peso lá.
    const posicao = createHash('sha1').update(palavra).digest().readUInt32BE(0) % dimensions;
    vetor[posicao] = (vetor[posicao] ?? 0) + 1;
  }
  const norma = Math.sqrt(vetor.reduce((soma, v) => soma + v * v, 0));
  if (norma === 0) return vetor;
  return vetor.map((v) => v / norma);
}

export class LexicalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'lexical-teste';
  readonly calls: EmbedRequest[] = [];

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.calls.push(request);
    const dimensions = request.dimensions ?? KNOWLEDGE_EMBEDDING_DIMENSIONS;
    return {
      embeddings: request.input.map((texto) => lexicalVector(texto, dimensions)),
      dimensions,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      model: 'lexical-teste',
    };
  }
}
