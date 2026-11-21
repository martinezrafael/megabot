# @megabot/knowledge

Transforma um documento em **trechos pesquisáveis**: extrai o texto (PDF, HTML, texto, CSV/TSV, XLSX), divide
em pedaços do tamanho certo e, quando a fonte é uma URL, baixa a página com as proteções de rede necessárias.

Não fala com banco, fila nem IA: é só função pura (mais o `fetch` da importação por URL). Quem orquestra é o
job `knowledge.ingest` do worker (T2.2, [ADR 0020](../../docs/adr/0020-ingestao-base-conhecimento.md)).

## O que tem

| Parte                 | Para quê                                                            | Arquivo                |
| --------------------- | ------------------------------------------------------------------- | ---------------------- |
| `detectFormat`        | Descobre o formato pelo tipo declarado e pela extensão              | `src/formats.ts`       |
| `extractDocument`     | Bytes -> texto ("markdown simples": `#`, `-`, `a \| b`)             | `src/extract/index.ts` |
| `chunkText`           | Texto -> trechos, respeitando seção, parágrafo e frase              | `src/chunk.ts`         |
| `fetchRemoteDocument` | Baixa uma página com limite de tempo/tamanho e proteção contra SSRF | `src/fetch-url.ts`     |
| `KnowledgeError`      | Erro com `code` e mensagem **pronta para a tela**, em português     | `src/errors.ts`        |

## Usar

```ts
import { chunkText, detectFormat, extractDocument, fetchRemoteDocument } from '@megabot/knowledge';

// Arquivo enviado
const format = detectFormat({ mimeType: 'application/pdf', fileName: 'politica.pdf' });
const doc = await extractDocument({ bytes, format, fileName: 'politica.pdf' });

// Página do site (valida esquema, resolve o DNS e exige IP público)
const remote = await fetchRemoteDocument('https://loja.com.br/faq', { maxBytes: 20 * 1024 * 1024 });

const chunks = chunkText(doc.text, { maxChars: 1200, overlapChars: 150 });
// [{ position: 0, content: 'Trocas\n\nEm até 30 dias...', heading: 'Trocas', charCount: 52 }, ...]
```

## Formatos

| Formato | Como vira texto                                                                       |
| ------- | ------------------------------------------------------------------------------------- |
| PDF     | Uma seção `## Página N` por página (sem texto = erro `sem_texto`, pede OCR)           |
| HTML    | Títulos viram `#`/`##`, listas viram `- `, tabelas viram `a \| b`; menu e rodapé saem |
| TXT/MD  | Como está (só normaliza quebras e espaços no fim das linhas)                          |
| CSV/TSV | `Coluna: valor \| Coluna: valor` por linha, usando a 1ª linha como cabeçalho          |
| XLSX    | Uma seção `## Aba: <nome>` por aba, com as linhas no mesmo formato do CSV             |

## Divisão em trechos

Padrão: 1200 caracteres por trecho, 150 de sobreposição. A ordem de corte é seção → parágrafo → frase →
palavra, e cada trecho leva o título da sua seção (para o agente saber de onde veio). É determinístico:
o mesmo texto gera sempre os mesmos trechos.

## Importação por URL: o que é bloqueado

Só http/https, sem usuário:senha; o domínio é resolvido e **todos** os IPs precisam ser públicos (bloqueia
`localhost`, `10.x`, `192.168.x`, `169.254.169.254` e companhia); redirecionamentos são seguidos à mão, com
revalidação a cada salto; e há limite de tempo e de tamanho. Limite conhecido (DNS rebinding) na ADR 0020.

## Testes

```bash
pnpm --filter @megabot/knowledge test        # sem rede: servidor HTTP local + arquivos de exemplo
pnpm --filter @megabot/knowledge fixtures    # recria os arquivos de teste (PDF e XLSX)
```
