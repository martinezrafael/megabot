/**
 * Divisão em trechos ("chunking").
 *
 * Por que dividir: o agente não manda a base inteira para o modelo; ele busca os poucos trechos
 * parecidos com a pergunta. Trecho grande demais mistura assuntos (a busca erra); pequeno demais
 * perde o contexto (a resposta fica solta).
 *
 * Como: respeitando a estrutura do texto. Primeiro por seção (as linhas `#`, `##` que os extratores
 * produzem), depois por parágrafo, depois por frase e, no pior caso, por palavra. Cada trecho leva o
 * título da sua seção, e trechos vizinhos se sobrepõem um pouco para uma frase cortada no fim de um
 * não ficar sem contexto no outro.
 *
 * É tudo determinístico: o mesmo texto gera sempre os mesmos trechos (reingestão não embaralha nada).
 */

export interface ChunkOptions {
  /** Tamanho máximo de um trecho, em caracteres (garantido: nenhum trecho passa disso). */
  maxChars?: number;
  /** Quantos caracteres do fim de um trecho repetir no começo do próximo. */
  overlapChars?: number;
  /** Trecho final menor que isto é juntado ao anterior, se couber. */
  minChars?: number;
}

export interface KnowledgeChunkDraft {
  position: number;
  content: string;
  /** Seção de onde o trecho veio (`## Aba: Produtos` -> `Aba: Produtos`). */
  heading: string | null;
  charCount: number;
}

export const DEFAULT_CHUNK_OPTIONS = {
  maxChars: 1200,
  overlapChars: 150,
  minChars: 200,
} as const;

interface Block {
  heading: string | null;
  text: string;
}

const HEADING_LINE = /^(#{1,6})\s+(.*\S)\s*$/;

/** Quebra o texto em blocos (parágrafos), guardando de qual seção cada um veio. */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) blocks.push({ heading, text: joined });
    buffer = [];
  };

  for (const rawLine of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    const match = HEADING_LINE.exec(line.trim());
    if (match) {
      flush();
      heading = match[2]!;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return blocks;
}

/** Divide um texto longo em partes de no máximo `max`, cortando em frase, palavra e, no limite, letra. */
function splitLongText(text: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();

  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    // Melhor corte: fim de frase; depois espaço; depois na marca exata.
    const sentenceEnd = Math.max(
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf('.\n'),
      window.lastIndexOf('\n'),
    );
    const cut =
      sentenceEnd > max * 0.4
        ? sentenceEnd + 1
        : window.lastIndexOf(' ') > max * 0.4
          ? window.lastIndexOf(' ')
          : max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) pieces.push(rest);
  return pieces.filter((piece) => piece.length > 0);
}

/** Pega o fim do trecho (até `size`) para repetir no começo do próximo, cortando em palavra. */
function tailFor(content: string, size: number): string {
  if (size <= 0 || content.length <= size) return content.length <= size ? content : '';
  const tail = content.slice(content.length - size);
  const space = tail.search(/[\s]/);
  return (space >= 0 ? tail.slice(space + 1) : tail).trim();
}

export function chunkText(text: string, options: ChunkOptions = {}): KnowledgeChunkDraft[] {
  const maxChars = Math.max(options.maxChars ?? DEFAULT_CHUNK_OPTIONS.maxChars, 100);
  const overlapChars = Math.min(
    Math.max(options.overlapChars ?? DEFAULT_CHUNK_OPTIONS.overlapChars, 0),
    Math.floor(maxChars / 3),
  );
  const minChars = Math.max(options.minChars ?? DEFAULT_CHUNK_OPTIONS.minChars, 0);

  const drafts: Array<{ heading: string | null; content: string }> = [];
  let heading: string | null = null;
  let parts: string[] = [];
  let length = 0;

  const prefixFor = (sectionHeading: string | null) =>
    sectionHeading ? `${sectionHeading}\n\n` : '';

  const flush = (carryOverlap: boolean) => {
    if (parts.length === 0) return;
    const content = `${prefixFor(heading)}${parts.join('\n\n')}`.trim();
    if (content) drafts.push({ heading, content });
    const overlap =
      carryOverlap && overlapChars > 0 ? tailFor(parts.join('\n\n'), overlapChars) : '';
    parts = overlap ? [overlap] : [];
    length = overlap.length;
  };

  for (const block of parseBlocks(text)) {
    if (block.heading !== heading) {
      flush(false); // seção nova: começa um trecho limpo (sem arrastar texto de outro assunto)
      heading = block.heading;
    }
    const prefixLength = prefixFor(heading).length;
    const budget = maxChars - prefixLength;

    for (const piece of splitLongText(block.text, Math.max(budget, 50))) {
      const separator = parts.length > 0 ? 2 : 0; // "\n\n"
      if (parts.length > 0 && prefixLength + length + separator + piece.length > maxChars) {
        flush(true);
      }
      // Depois da sobreposição o espaço pode ainda não bastar: aí vai sem sobreposição.
      if (parts.length > 0 && prefixLength + length + 2 + piece.length > maxChars) {
        parts = [];
        length = 0;
      }
      parts.push(piece);
      length += (parts.length > 1 ? 2 : 0) + piece.length;
    }
  }
  flush(false);

  // Último trecho curto: junta no anterior quando couber (evita um "sobrinho" de 20 caracteres).
  if (drafts.length >= 2) {
    const last = drafts[drafts.length - 1]!;
    const previous = drafts[drafts.length - 2]!;
    const merged = `${previous.content}\n\n${last.content.slice(prefixFor(last.heading).length).trim()}`;
    if (
      last.content.length < minChars &&
      last.heading === previous.heading &&
      merged.length <= maxChars
    ) {
      previous.content = merged;
      drafts.pop();
    }
  }

  return drafts.map((draft, position) => ({
    position,
    content: draft.content,
    heading: draft.heading,
    charCount: draft.content.length,
  }));
}
