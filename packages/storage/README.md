# @megabot/storage

Guarda os arquivos enviados para a base de conhecimento. Dois drivers, uma interface:

- **`local`** (padrão): uma pasta no disco (`.data/uploads`). É o que faz `pnpm dev` funcionar sem conta em nuvem.
- **`r2` / `s3`**: bucket da Cloudflare R2 ou da AWS S3 (mesmo protocolo).

```ts
import { buildKnowledgeObjectKey, createStorageFromEnv } from '@megabot/storage';

const storage = createStorageFromEnv(); // lê STORAGE_* do ambiente
const key = buildKnowledgeObjectKey({ tenantId, sourceId, fileName: 'Política de trocas.pdf' });
// tenants/<tenantId>/knowledge/<sourceId>/politica-de-trocas.pdf

await storage.put(key, bytes, { contentType: 'application/pdf' });
const data = await storage.get(key);
await storage.delete(key); // apagar o que não existe NÃO é erro
```

## Configuração

| Variável                    | Para quê                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `STORAGE_DRIVER`            | `local` (padrão), `r2` ou `s3`                                 |
| `STORAGE_LOCAL_DIR`         | Pasta do driver local (padrão `.data/uploads`)                 |
| `STORAGE_BUCKET`            | Nome do bucket (obrigatório em r2/s3)                          |
| `STORAGE_ENDPOINT`          | `https://<conta>.r2.cloudflarestorage.com` (obrigatório na R2) |
| `STORAGE_REGION`            | `auto` na R2; a região do bucket na AWS                        |
| `STORAGE_ACCESS_KEY_ID`     | Credencial (obrigatória em r2/s3)                              |
| `STORAGE_SECRET_ACCESS_KEY` | Credencial (obrigatória em r2/s3)                              |
| `STORAGE_FORCE_PATH_STYLE`  | `true` para R2/MinIO (padrão quando há endpoint)               |

Configuração incompleta falha na **subida** do processo, dizendo exatamente o que falta.

## Erros

`StorageError` com `code` e `retryable`: `nao_encontrado` (arquivo sumiu), `configuracao` (credencial/bucket),
`indisponivel` (rede/serviço — vale repetir) e `chave_invalida` (tentativa de sair da pasta, caractere proibido).

## Segurança

Toda chave passa por `assertValidKey`: nada de caminho absoluto, `..`, barra dupla ou caractere estranho — no
driver local isso seria ler ou gravar fora da pasta. O nome do arquivo enviado é normalizado
(`slugifyFileName`): sem acento, sem espaço e sem caminho.

## Testes

```bash
pnpm --filter @megabot/storage test   # disco de verdade (pasta temporária) e dublê do cliente S3
```
