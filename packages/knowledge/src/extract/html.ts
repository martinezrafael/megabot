import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * HTML -> texto em "markdown simples": `#`/`##`/`###` para títulos, parágrafos separados por linha
 * em branco, `- ` para itens de lista e `|` entre células de tabela. É esse formato que o divisor
 * de trechos (chunk.ts) entende para saber de qual seção cada trecho veio.
 *
 * Também joga fora o que não é conteúdo (menus, rodapés, scripts, formulários) e, quando a página
 * marca o conteúdo principal com <main> ou <article>, lê só essa parte.
 */

/** Removidos antes de qualquer leitura: não são conteúdo ou são barulho de navegação. */
const DROP =
  'script,style,noscript,template,svg,canvas,iframe,form,button,select,nav,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true]';

const HEADINGS: Record<string, string> = {
  h1: '#',
  h2: '##',
  h3: '###',
  h4: '###',
  h5: '###',
  h6: '###',
};
const BLOCKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'ul',
  'ol',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'address',
  'hr',
  'details',
  'summary',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
]);

export interface HtmlExtraction {
  text: string;
  /** <title> da página (ou o primeiro <h1>), já limpo. */
  title: string | null;
}

export function htmlToText(html: string): HtmlExtraction {
  const $ = load(html);
  $(DROP).remove();

  const title = clean($('head > title').first().text()) || clean($('h1').first().text()) || null;

  const main = $('main').first();
  const article = $('article').first();
  const root: Cheerio<AnyNode> = main.length
    ? main
    : article.length
      ? article
      : $('body').length
        ? $('body')
        : $.root();

  const out: string[] = [];
  for (const node of root.contents().toArray()) walk($, node, out);

  return { text: normalize(out.join('')), title };
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

function walk($: CheerioAPI, node: AnyNode, out: string[]): void {
  if (node.type === 'text') {
    out.push(node.data.replace(/\s+/g, ' '));
    return;
  }
  if (node.type !== 'tag') return;
  const tag = node.tagName.toLowerCase();

  if (tag === 'br') return void out.push('\n');
  if (tag === 'hr') return void out.push('\n\n');
  if (tag === 'img') {
    // O texto alternativo costuma ser a única descrição da imagem.
    const alt = clean($(node).attr('alt') ?? '');
    if (alt) out.push(`\n${alt}\n`);
    return;
  }

  const heading = HEADINGS[tag];
  if (heading) {
    const text = clean($(node).text());
    if (text) out.push(`\n\n${heading} ${text}\n\n`);
    return;
  }

  if (tag === 'pre') {
    // Em <pre> as QUEBRAS DE LINHA são conteúdo (código, endereço, horários), por isso são mantidas.
    // A indentação, não: ela é normalizada como no resto do texto (não ajuda a busca por similaridade).
    const text = $(node)
      .text()
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '');
    if (text.trim()) out.push(`\n\n${text.trim()}\n\n`);
    return;
  }

  if (tag === 'li') {
    // Só a quebra de abertura: o próximo item traz a sua, e assim a lista não ganha linhas vazias.
    out.push('\n- ');
    for (const child of $(node).contents().toArray()) walk($, child, out);
    return;
  }

  if (tag === 'tr') {
    const cells = $(node)
      .children('th,td')
      .toArray()
      .map((cell) => clean($(cell).text()))
      .filter((cell) => cell.length > 0);
    // Igual à lista: só a quebra de abertura, para as linhas da tabela ficarem juntas.
    if (cells.length) out.push(`\n${cells.join(' | ')}`);
    return;
  }

  const isBlock = BLOCKS.has(tag);
  if (isBlock) out.push('\n\n');
  for (const child of $(node).contents().toArray()) walk($, child, out);
  if (isBlock) out.push('\n\n');
}

/** Tira espaços repetidos, limita a 1 linha em branco entre blocos e remove linhas vazias. */
function normalize(raw: string): string {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  const result: string[] = [];
  for (const line of lines) {
    if (line === '') {
      if (result.length > 0 && result[result.length - 1] !== '') result.push('');
      continue;
    }
    result.push(line);
  }
  while (result.length && result[result.length - 1] === '') result.pop();
  return result.join('\n');
}
