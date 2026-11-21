# ADR 0020 — Ingestão da base de conhecimento

- **Status:** Aceita
- **Data:** 2026-11-21
- **Contexto da task:** T2.2 (usa o [ADR 0019](0019-pacote-ai.md) para embeddings e o [ADR 0004](0004-prisma-e-postgresql.md) para o banco)

## Contexto

O assistente precisa responder com o conteúdo de cada empresa: site, PDFs, planilhas e textos soltos. Para
isso o conteúdo tem de virar **trechos pesquisáveis por significado** (embeddings), com isolamento por tenant,
acompanhamento do processamento e mensagens de erro que o cliente entenda sozinho.

## Decisões

| Tema                 | Escolha                                                                                                                                                                                | Por quê                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Modelo de dados      | `knowledge_sources` (uma fonte: arquivo, URL ou texto) + `knowledge_chunks` (trechos com `embedding vector(1536)`), ambos com RLS + FORCE e chave estrangeira composta com `tenant_id` | Mesma regra de isolamento do resto (ADR 0004); impossível ligar trecho de um tenant a fonte de outro |
| Busca vetorial       | pgvector com índice **HNSW** e distância de **cosseno** (`vector_cosine_ops`)                                                                                                          | Já vem na imagem do compose; HNSW é rápido para buscar e barato de manter                            |
| Dimensão fixa (1536) | O tipo da coluna fixa 1536; o worker pede exatamente essa dimensão ao provedor                                                                                                         | pgvector exige dimensão no tipo. Trocar de modelo = migration + reindexar (documentado)              |
| Armazenamento        | Pacote `@megabot/storage` com dois drivers: **R2/S3** (produção) e **disco local** (padrão, dev)                                                                                       | `pnpm dev` funciona sem conta em nuvem; trocar de provedor não mexe no resto do código               |
| Upload               | O corpo da requisição é o **arquivo cru** (`POST /knowledge/sources/upload?fileName=...`), sem multipart e sem URL pré-assinada                                                        | Uma dependência a menos; a API valida tipo e tamanho ANTES de guardar; do navegador é `body: file`   |
| Ordem do upload      | Grava no storage e só então cria a linha; se o banco recusar, o arquivo é apagado                                                                                                      | Nunca sobra fonte apontando para um arquivo que não existe                                           |
| Extração             | Pacote `@megabot/knowledge`: `unpdf` (PDF), `cheerio` (HTML), `exceljs` (XLSX) e parser próprio de CSV/TSV. Tudo vira "markdown simples" (`#`, `-`, `a \| b`)                          | Um formato único de saída simplifica a divisão em trechos e deixa a seção de origem explícita        |
| PDF sem texto        | Erro `sem_texto` explicando que é documento escaneado                                                                                                                                  | OCR não entra agora (custo/latência); o cliente recebe instrução clara                               |
| Divisão em trechos   | Por seção → parágrafo → frase → palavra; padrão 1200 caracteres com 150 de sobreposição; cada trecho leva o título da seção                                                            | Trecho tem de fazer sentido sozinho; a sobreposição evita perder contexto no corte                   |
| Importação por URL   | Só http/https, sem usuário:senha, **DNS resolvido e IPs públicos obrigatórios**, redirecionamentos revalidados a cada salto, tempo e tamanho máximos                                   | O servidor busca um endereço escolhido pelo cliente: é o caminho clássico de SSRF                    |
| Fila                 | `knowledge.ingest` (payload `{tenantId, sourceId, mode}`), concorrência 2, 15 min de teto, 3 retentativas                                                                              | Ingestão é lenta e depende de provedor externo                                                       |
| Quem enfileira       | Um **relay no worker** varre fontes `pending` (como o relay do webhook, ADR 0018), com `jobId` derivado de `updatedAt`                                                                 | A API continua sem depender do pg-boss; nada se perde se a fila estiver fora                         |
| Edição manual        | Editar um trecho marca `embedding_stale`; o relay enfileira o modo `stale`, que só recalcula o embedding daquele trecho                                                                | O texto do cliente vale na hora e não é sobrescrito por uma reingestão completa                      |
| Reingestão           | Troca TODOS os trechos numa transação (edições manuais são perdidas, com aviso na tela)                                                                                                | Idempotência: rodar duas vezes dá o mesmo resultado                                                  |
| Erros                | Cada falha vira `error_code` + mensagem em português na tela; só a ÚLTIMA tentativa marca a fonte como `failed`                                                                        | Quem usa entende o que fazer; erro passageiro não assusta o cliente no meio do caminho               |
| Observabilidade      | Logs `knowledge.*` e métricas `knowledge_ingest_total`, `knowledge_chunks_total`, `knowledge_ingest_duration_ms`, sempre com `tenant_id`. Nunca o conteúdo do documento                | LGPD e o DoD da task                                                                                 |

## Consequências

- **Bom:** o cliente alimenta a base sozinho, acompanha o progresso e corrige trechos; a busca por similaridade
  já funciona (`searchKnowledgeChunks`), pronta para o agente da próxima task.
- **Atenção:** a dimensão do embedding está presa ao tipo da coluna; mudar de modelo exige migration e
  reindexação. O driver local não serve para produção com mais de uma máquina.
- **Limite conhecido (SSRF):** entre checar o IP e conectar, o DNS pode mudar (DNS rebinding). Fechar isso
  exige conectar no IP já validado ou usar um proxy de saída — fica para quando houver rede dedicada.
- **Pendente:** OCR para PDF escaneado; varrer um site inteiro (hoje é uma página por vez); upload direto para
  a R2 com URL pré-assinada (hoje passa pela API); reindexação automática quando o modelo de embedding mudar.
