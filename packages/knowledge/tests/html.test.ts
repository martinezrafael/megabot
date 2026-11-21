import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { htmlToText } from '../src';

describe('HTML -> texto', () => {
  it('títulos, parágrafos, listas e tabelas em markdown simples', () => {
    const { text, title } = htmlToText(`
      <html><head><title>Loja Exemplo</title></head><body>
        <h1>Sobre a loja</h1>
        <p>Vendemos <b>camisetas</b> e <i>calças</i> desde 2010.</p>
        <h2>Entrega</h2>
        <ul><li>Capitais: 2 dias</li><li>Interior: 5 dias</li></ul>
        <table>
          <tr><th>Produto</th><th>Preço</th></tr>
          <tr><td>Camiseta</td><td>R$ 79,90</td></tr>
        </table>
      </body></html>`);

    assert.equal(title, 'Loja Exemplo');
    assert.equal(
      text,
      [
        '# Sobre a loja',
        '',
        'Vendemos camisetas e calças desde 2010.',
        '',
        '## Entrega',
        '',
        '- Capitais: 2 dias',
        '- Interior: 5 dias',
        '',
        'Produto | Preço',
        'Camiseta | R$ 79,90',
      ].join('\n'),
    );
  });

  it('joga fora script, style, menu, rodapé e formulário', () => {
    const { text } = htmlToText(`
      <body>
        <nav>Início Produtos Contato</nav>
        <script>var preco = 10;</script>
        <style>.a{color:red}</style>
        <form><input name="email"><button>Assinar</button></form>
        <p>Conteúdo que importa.</p>
        <footer>CNPJ 00.000.000/0001-00</footer>
        <div aria-hidden="true">decorativo</div>
      </body>`);
    assert.equal(text, 'Conteúdo que importa.');
  });

  it('prefere <main> (ou <article>) quando a página marca o conteúdo principal', () => {
    const html = `<body><div>Barra lateral com promoções</div>
      <main><h2>Trocas</h2><p>Em até 30 dias.</p></main>
      <div>Mais links</div></body>`;
    const { text } = htmlToText(html);
    assert.equal(text, '## Trocas\n\nEm até 30 dias.');

    const article = htmlToText('<body><p>fora</p><article><p>dentro</p></article></body>');
    assert.equal(article.text, 'dentro');
  });

  it('usa o texto alternativo das imagens e o <h1> quando não há <title>', () => {
    const { text, title } = htmlToText(
      '<body><h1>Catálogo 2026</h1><p>Veja:</p><img src="a.jpg" alt="Camiseta preta tamanho M"><img src="b.jpg"></body>',
    );
    assert.equal(title, 'Catálogo 2026');
    assert.match(text, /Camiseta preta tamanho M/);
  });

  it('mantém as quebras de linha de <pre> e de <br>', () => {
    const { text } = htmlToText(
      '<body><p>Seg a Sex<br>9h às 18h</p><pre>Rua A, 100\n  Sala 2\nSão Paulo</pre></body>',
    );
    assert.match(text, /Seg a Sex\n9h às 18h/);
    // As quebras ficam; a indentação é normalizada (não ajuda a busca).
    assert.match(text, /Rua A, 100\nSala 2\nSão Paulo/);
  });

  it('não devolve linhas em branco seguidas nem espaços sobrando', () => {
    const { text } = htmlToText(
      '<body><div><div><div><p>  muito   espaço  </p></div></div></div><p></p><p>fim</p></body>',
    );
    assert.equal(text, 'muito espaço\n\nfim');
  });

  it('página sem corpo útil devolve texto vazio (quem decide o erro é o extractDocument)', () => {
    assert.equal(htmlToText('<html><head><title>x</title></head><body></body></html>').text, '');
  });
});
