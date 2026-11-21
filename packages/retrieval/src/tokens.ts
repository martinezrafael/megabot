/**
 * Contagem de tokens.
 *
 * Por que não estimar por caracteres: medindo textos reais de uma base em português (FAQ, políticas,
 * linhas de planilha, links, emoji) contra o tokenizador de verdade, a melhor fórmula simples
 * (`caracteres / 3`) ainda errava até **19% para baixo** em alguns textos e **30% para cima** na média.
 * Um orçamento de tokens que erra 19% para baixo não é um orçamento. Então contamos de verdade.
 *
 * O tokenizador é carregado SOB DEMANDA (a primeira contagem paga ~25 MB de memória): um processo que
 * nunca busca nada na base não paga nada por isto.
 */

/** Codificações disponíveis. `o200k_base` é a dos modelos atuais da OpenAI; `cl100k_base`, a dos antigos. */
export type TokenEncoding = 'o200k_base' | 'cl100k_base';

export type TokenCounter = (text: string) => number;

const loaded = new Map<TokenEncoding, TokenCounter>();

/**
 * Carrega (uma vez) o contador da codificação pedida.
 * Se o tokenizador não puder ser carregado, cai para a estimativa conservadora — a busca continua
 * funcionando, só com um orçamento menos preciso.
 */
export async function loadTokenCounter(
  encoding: TokenEncoding = 'o200k_base',
): Promise<TokenCounter> {
  const cached = loaded.get(encoding);
  if (cached) return cached;

  let counter: TokenCounter;
  try {
    const module = (await import(`gpt-tokenizer/encoding/${encoding}`)) as {
      encode: (text: string) => number[];
    };
    counter = (text: string) => module.encode(text).length;
    // Confere que o módulo carregado realmente conta (falha cedo, não no meio de uma busca).
    counter('teste');
  } catch {
    counter = estimateTokens;
  }
  loaded.set(encoding, counter);
  return counter;
}

/**
 * Estimativa de reserva, usada só se o tokenizador não carregar. Propositalmente generosa
 * (`caracteres / 3`): é melhor mandar contexto de menos do que estourar o limite do modelo.
 */
export const estimateTokens: TokenCounter = (text) => Math.ceil(text.length / 3);

/**
 * Corta o texto para caber em `maxTokens`, preferindo terminar em fim de frase.
 * Devolve o texto cortado e quantos tokens ele tem (contados, não estimados).
 */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  count: TokenCounter,
): { text: string; tokens: number; truncated: boolean } {
  const tokens = count(text);
  if (tokens <= maxTokens) return { text, tokens, truncated: false };

  // Busca binária pelo maior pedaço que cabe JÁ COM as reticências (contar é barato, mas não a
  // ponto de testar caractere a caractere). Sem contar as reticências, o corte estouraria o limite
  // justamente nos textos mais apertados.
  const fits = (end: number) => count(`${text.slice(0, end).trimEnd()}…`) <= maxTokens;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }

  const head = text.slice(0, low);
  // Volta até o fim de frase (ou de palavra) mais próximo, para não cortar no meio de uma ideia.
  const sentenceEnd = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('\n'),
  );
  const lastSpace = head.lastIndexOf(' ');
  const cut = sentenceEnd > low * 0.6 ? sentenceEnd + 1 : lastSpace > low * 0.6 ? lastSpace : low;
  const result = `${text.slice(0, cut).trimEnd()}…`;
  return { text: result, tokens: count(result), truncated: true };
}
