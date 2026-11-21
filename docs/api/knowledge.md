# API da base de conhecimento (T2.2)

Rotas do **tenant logado** (cookie de sessão). O `tenantId` nunca vem do corpo nem da URL: sai da sessão, então
ninguém consegue ler ou mexer na base de outra empresa. Contrato completo no OpenAPI (`/docs`, tag `knowledge`).

Fluxo: criar a fonte → ela nasce `pending` → o worker processa (`processing`, com `progress` de 0 a 100) →
termina em `ready` (com trechos) ou `failed` (com `errorCode` e `errorMessage` em português).

## Fontes

| Rota                                    | O que faz                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /knowledge/limits`                 | Tamanho máximo de upload e extensões aceitas (a tela usa para validar antes) |
| `GET /knowledge/sources`                | Lista as fontes, da mais nova para a mais antiga                             |
| `POST /knowledge/sources`               | Cria fonte por **URL** ou **texto colado**                                   |
| `POST /knowledge/sources/upload`        | Envia um **arquivo** (corpo = bytes do arquivo)                              |
| `GET /knowledge/sources/{id}`           | Uma fonte (status, progresso, erro, contadores)                              |
| `POST /knowledge/sources/{id}/reingest` | Processa de novo (descarta edições manuais de trechos)                       |
| `DELETE /knowledge/sources/{id}`        | Apaga fonte, trechos e o arquivo guardado                                    |

### `POST /knowledge/sources`

```json
{ "kind": "url", "url": "https://suaempresa.com.br/faq", "title": "FAQ (opcional)" }
{ "kind": "text", "text": "Horário de atendimento...", "title": "Horários (opcional)" }
```

| Status | Quando                                                                     |
| ------ | -------------------------------------------------------------------------- |
| 201    | Fonte criada (`status: "pending"`)                                         |
| 400    | Corpo inválido, URL fora do padrão http/https ou texto vazio/grande demais |
| 401    | Sem sessão                                                                 |
| 403    | Conta sem empresa associada                                                |

O endereço só é **verificado na forma** aqui; quem baixa a página é o worker, que recusa endereços de rede
interna (`url_bloqueada`) e sites fora do ar (`url_inacessivel`).

### `POST /knowledge/sources/upload?fileName=<nome>&title=<opcional>`

O corpo é o **conteúdo do arquivo** (não é multipart). Informe o tipo em `Content-Type`.

```bash
curl -X POST "http://localhost:3000/knowledge/sources/upload?fileName=politica.pdf" \
  -H 'Content-Type: application/pdf' -H "Cookie: <sessão>" --data-binary @politica.pdf
```

No navegador: `fetch(url, { method: 'POST', body: file, credentials: 'include' })`.

| Status | Quando                                                     |
| ------ | ---------------------------------------------------------- |
| 201    | Arquivo guardado e fonte criada                            |
| 400    | Arquivo vazio, formato não suportado ou `fileName` ausente |
| 413    | Arquivo maior que `KNOWLEDGE_MAX_UPLOAD_MB`                |
| 503    | Armazenamento indisponível ou mal configurado              |

## Trechos

| Rota                                              | O que faz                                              |
| ------------------------------------------------- | ------------------------------------------------------ |
| `GET /knowledge/sources/{id}/chunks?limit&offset` | Lista os trechos (padrão 50, máximo 200)               |
| `PATCH /knowledge/chunks/{chunkId}`               | Edita o texto (`{ "content": "..." }`, até 8000 chars) |
| `DELETE /knowledge/chunks/{chunkId}`              | Apaga o trecho                                         |

A resposta de um trecho traz `hasEmbedding`, `embeddingStale` (texto novo esperando o embedding ser
recalculado) e `edited`. O vetor em si nunca é devolvido.

## Códigos de erro da ingestão (`errorCode`)

| Código                  | Significado                                            | Repete sozinho? |
| ----------------------- | ------------------------------------------------------ | --------------- |
| `formato_nao_suportado` | Tipo de arquivo que não sabemos ler                    | não             |
| `documento_vazio`       | Arquivo/página sem conteúdo                            | não             |
| `sem_texto`             | Sem texto extraível (PDF escaneado, por exemplo)       | não             |
| `arquivo_grande`        | Passou do limite de tamanho                            | não             |
| `pdf_invalido`          | PDF corrompido ou protegido por senha                  | não             |
| `planilha_invalida`     | XLSX ilegível                                          | não             |
| `url_invalida`          | Endereço fora do padrão http/https                     | não             |
| `url_bloqueada`         | Endereço aponta para a rede interna do servidor        | não             |
| `url_inacessivel`       | Site fora do ar, lento ou domínio inexistente          | sim             |
| `url_erro_http`         | Site respondeu erro (4xx não repete; 429/5xx repetem)  | depende         |
| `arquivo_ausente`       | O arquivo sumiu do armazenamento                       | não             |
| `ia_*`                  | Falha do provedor de IA (`ia_quota`, `ia_rate_limit`…) | depende         |

## Logs e métricas

- API: `knowledge.source.created`, `knowledge.source.deleted`, `knowledge.chunk.updated`, `knowledge.chunk.deleted`.
- Worker: `knowledge.ingest.started|finished|failed`, `knowledge.reembed.finished`, `knowledge_relay.enqueued`.
- Métricas: `knowledge_sources_total{kind,outcome}`, `knowledge_ingest_total{kind,outcome}`,
  `knowledge_chunks_total`, `knowledge_ingest_duration_ms`, `knowledge_chunks_reembedded_total`.
- Todos com `tenant_id`. **Nunca** sai conteúdo de documento, texto de trecho ou embedding no log.
