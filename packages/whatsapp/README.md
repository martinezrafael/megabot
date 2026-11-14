# @megabot/whatsapp

Biblioteca que conversa com a **WhatsApp Cloud API** (Meta): **envia** mensagens e **entende** os avisos (webhooks) recebidos. Não depende de NestJS nem do banco: quem usa (API/worker) injeta o logger e as métricas.

## O que tem

| Parte            | Para quê                                                                    | Arquivo                |
| ---------------- | --------------------------------------------------------------------------- | ---------------------- |
| `WhatsAppClient` | Enviar texto, template e mídia; subir/baixar/apagar mídia; marcar como lida | `src/client.ts`        |
| `parseWebhook`   | Transformar o JSON da Meta em eventos simples e tipados                     | `src/webhook.ts`       |
| Assinatura       | `verifyWebhookSignature` (POST) e `verifyWebhookChallenge` (GET)            | `src/webhook.ts`       |
| Erros            | `WhatsAppApiError` com `category` e `retryable`; tabela de códigos da Meta  | `src/errors.ts`        |
| Observabilidade  | Contratos de log/métrica e nomes das métricas (`METRIC`)                    | `src/observability.ts` |

## Enviar mensagens

Um cliente é **de um número de um tenant** (cada tenant usa o seu token e `phone_number_id`).

```ts
import { WhatsAppClient } from '@megabot/whatsapp';

const wa = new WhatsAppClient({
  accessToken: process.env.WHATSAPP_API_TOKEN!,
  phoneNumberId: '106540352242922',
  tenantId: 'uuid-do-tenant', // vai em todo log e métrica
  logger, // opcional: pino já serve
  metrics, // opcional: { increment(name, labels, value), timing(name, ms, labels) }
});

// Texto (só dentro da janela de 24h, ADR 0010)
const { messageId } = await wa.sendText({ to: '+55 11 99999-0000', body: 'Olá!' });

// Template (necessário fora da janela)
await wa.sendTemplate({
  to: '5511999990000',
  name: 'confirmacao_pedido',
  language: 'pt_BR',
  components: [{ type: 'body', parameters: [{ type: 'text', text: 'Maria' }] }],
});

// Mídia: suba uma vez e reutilize o id, ou use um link HTTPS público
const { id } = await wa.uploadMedia({ data: bytes, mimeType: 'image/png', filename: 'a.png' });
await wa.sendMedia({ to: '5511999990000', kind: 'image', media: { id }, caption: 'Foto' });
await wa.sendMedia({
  to: '5511999990000',
  kind: 'document',
  media: { link: 'https://cdn.x.com/a.pdf' },
  filename: 'a.pdf',
});

// Mídia recebida: baixa, confere tamanho e SHA-256
const { data, mimeType } = await wa.downloadMedia(mediaIdDoWebhook);
```

Regras úteis:

- O telefone aceita `+55 (11) 99999-0000`; é normalizado para só dígitos (7 a 15).
- Entrada inválida (telefone, texto > 4096, mídia fora dos limites, link sem HTTPS) **falha antes** de chamar a Meta.
- **Não há retentativa interna.** Quem chama (pg-boss) decide, olhando `error.retryable`, e deve usar o `messageId`/uma chave própria para evitar duplicar envios.
- Tempo máximo por chamada: 15 s (`timeoutMs`). Versão do Graph API: `apiVersion` (padrão `v23.0`).

## Receber webhooks

```ts
import { parseWebhook, verifyWebhookSignature, verifyWebhookChallenge } from '@megabot/whatsapp';

// GET /webhooks/whatsapp  (cadastro do webhook na Meta)
const challenge = verifyWebhookChallenge(req.query, process.env.WHATSAPP_VERIFY_TOKEN!);
// challenge === null -> responda 403; senão, responda 200 com o texto do challenge

// POST /webhooks/whatsapp
if (!verifyWebhookSignature(rawBody, req.headers['x-hub-signature-256'], appSecret)) return 401;
const { events, invalid, ignored } = parseWebhook(JSON.parse(rawBody), {
  tenantId,
  logger,
  metrics,
});

for (const event of events) {
  if (event.kind === 'message') {
    // event.id (deduplicar), event.from, event.timestamp (abre/renova a janela), event.type, event.text, event.media...
  } else if (event.kind === 'status') {
    // event.messageId, event.status (sent|delivered|read|failed), event.errors
  } else {
    // event.kind === 'error': erro de conta/sistema
  }
}
```

- **Use o corpo bruto** (antes do `JSON.parse`) na assinatura. Responda 200 rápido e processe em fila.
- `event.phoneNumberId` identifica o número da empresa: é por ele que a API descobre o tenant.
- Um item malformado vai para `invalid` (com o caminho) e **não** derruba o resto do lote. Payload que nem é da Meta lança `WebhookPayloadError`.
- Tipos ainda não tratados chegam como `type: 'unknown'` (com `rawType`); campos como grupos entram em `ignored`.

### Tipos de mensagem entendidos

`text`, `image`, `audio` (inclui nota de voz), `video`, `document`, `sticker`, `location`, `contacts`, `button` (resposta rápida de template), `interactive` (botão, lista, flow), `reaction`, `unsupported`.

## Erros

Todo erro herda de `WhatsAppError` e tem `category` e `retryable`.

| Categoria         | Exemplos de código               | Repetir? | O que fazer                                   |
| ----------------- | -------------------------------- | -------- | --------------------------------------------- |
| `auth`            | 190, 0, 131005                   | não      | Renovar token/permissão (alertar o tenant)    |
| `rate_limit`      | 130429, 131056, 80007            | sim      | Repetir com espera crescente                  |
| `window_expired`  | 131047                           | não      | Janela de 24h fechada: só template (ADR 0010) |
| `recipient`       | 131026, 131050, 130403           | não      | Contato sem WhatsApp/bloqueou/optou por sair  |
| `template`        | 132000, 132001, 132015           | não      | Corrigir ou trocar o template                 |
| `media`           | 131052, 131053                   | não      | Pedir reenvio / revisar formato               |
| `invalid_request` | 100, 131008, 131009              | não      | Bug nosso                                     |
| `account`         | 131031, 131042, 368              | não      | Ação humana na conta da Meta                  |
| `temporary`       | 1, 2, 131000, 5xx, rede, timeout | sim      | Repetir                                       |

`WhatsAppApiError` também traz `code`, `subcode`, `details` e `fbtraceId` (para abrir chamado na Meta). O token **nunca** aparece em erros nem logs.

## Logs e métricas

Cada chamada gera **um** log estruturado:

```json
{
  "event": "whatsapp.request",
  "tenant_id": "...",
  "phone_number_id": "...",
  "operation": "send_text",
  "outcome": "success",
  "status": 200,
  "duration_ms": 182,
  "message_id": "wamid...",
  "to_suffix": "***0000"
}
```

Em erro: `outcome: "error"`, `error_code`, `error_category`, `retryable`, `fbtrace_id` (nível `warn` se repetível, `error` se não). **Nunca** vão para o log: token, texto das mensagens e telefone completo.

Métricas (`METRIC`): `whatsapp_api_requests_total` {tenant_id, operation, outcome, error_category}, `whatsapp_api_request_duration_ms` {tenant_id, operation}, `whatsapp_webhook_events_total` {kind, type, tenant_id?}, `whatsapp_webhook_invalid_total`.

## Testes

```bash
pnpm --filter @megabot/whatsapp test
```

Não precisam de banco nem de rede (o `fetch` é injetado). Os webhooks são testados contra fixtures em `tests/fixtures/`: dois exemplos **oficiais** da Meta (copiados da documentação) e os demais **modelados** a partir da documentação. Para validar com payloads **reais**, salve o JSON recebido no seu número de teste em `tests/fixtures/real/`; o teste `real-payloads.test.ts` o executa automaticamente.

## Limites conhecidos

- A documentação oficial da Meta só foi consultada em parte; a tabela de códigos de erro combina a Meta e referências de parceiros. Revise ao integrar.
- Fora do escopo desta versão: mensagens interativas de envio (botões/lista/flows), catálogo/pedidos, grupos, gerenciamento de templates.
- Números brasileiros: o `wa_id` devolvido pela Meta pode diferir do número enviado (ex.: nono dígito). Use `waId` da resposta/webhook como chave do contato.
