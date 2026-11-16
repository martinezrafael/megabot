# Webhook de entrada do WhatsApp

Rota: `GET` e `POST` em `/webhooks/whatsapp` (pública, sem sessão). Quem protege é a assinatura da Meta.

## Como funciona

| Passo | O que acontece                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------- |
| 1     | `POST` chega com o cabeçalho `X-Hub-Signature-256`. O corpo é lido **cru** (bytes exatos).                          |
| 2     | Confere `sha256=HMAC(corpo, WHATSAPP_APP_SECRET)`. Errado: **401**, nada é gravado.                                 |
| 3     | Interpreta o JSON com `@megabot/whatsapp`. Não é webhook do WhatsApp: **400**. Item ruim isolado: só é ignorado.    |
| 4     | Para cada `phone_number_id`, descobre o tenant (`whatsapp_connections`). Sem tenant: loga, descarta, responde 200.  |
| 5     | Grava em `webhook_events` como `pending`. Já existia (mesma chave): ignora. Falha no banco: **500** (Meta reenvia). |
| 6     | Responde `200 {"status":"ok"}`. O processamento de verdade é do worker.                                             |

| Resposta | Quando                                     | A Meta reenvia?                            |
| -------- | ------------------------------------------ | ------------------------------------------ |
| 200      | Gravado, duplicado ou número sem tenant    | não                                        |
| 400      | Assinatura ok, mas corpo não é do WhatsApp | sim (poucas)                               |
| 401      | Assinatura ausente ou errada               | sim                                        |
| 413      | Corpo acima de 3 MB                        | —                                          |
| 503      | `WHATSAPP_APP_SECRET` não configurado      | sim                                        |
| 500      | Falha ao gravar no banco                   | sim (e é seguro: a gravação é idempotente) |

## Configurar no ambiente local

1. No `.env`, defina:
   - `WHATSAPP_APP_SECRET`: Meta for Developers > seu app > Configurações > Básico > "Chave secreta do app".
   - `WHATSAPP_VERIFY_TOKEN`: invente (`openssl rand -hex 16`).
2. Suba a API (`pnpm dev`) e o túnel (`pnpm tunnel`). Anote a URL HTTPS do ngrok.
3. Meta for Developers > WhatsApp > Configuração > Webhook:
   - URL de callback: `https://SEU-TUNEL.ngrok-free.app/webhooks/whatsapp`
   - Verificar token: o mesmo `WHATSAPP_VERIFY_TOKEN`
   - Clique em **Verificar e salvar** (a Meta chama o `GET`) e assine o campo **messages**.
4. Ligue o seu número a um tenant (ainda não há tela):
   - Faça login no sistema e abra `GET /me`: copie `tenant.id`.
   - Pegue `phone_number_id` e `waba_id` em WhatsApp > Configuração da API.
   - Rode: `pnpm db:whatsapp-connect --tenant <tenant.id> --phone-number-id <id> --waba-id <id>`
5. Envie uma mensagem para o número de teste. Confira no banco:

   ```bash
   docker exec -it megabot_postgres psql -U postgres -d megabot \
     -c "select kind, status, wamid, event_at, process_status from webhook_events order by received_at desc limit 5;"
   ```

   (Como `postgres` você enxerga tudo; a aplicação enxerga só o próprio tenant, por causa do RLS.)

## Testar sem a Meta (curl assinado)

```bash
SECRET='o-mesmo-WHATSAPP_APP_SECRET'
BODY='{"object":"whatsapp_business_account","entry":[{"id":"1","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"15550001111","phone_number_id":"SEU_PHONE_NUMBER_ID"},"contacts":[{"profile":{"name":"Teste"},"wa_id":"5511999990000"}],"messages":[{"from":"5511999990000","id":"wamid.TESTE1","timestamp":"1749416383","type":"text","text":{"body":"oi"}}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -i -X POST http://localhost:3000/webhooks/whatsapp \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: $SIG" --data-binary "$BODY"
```

Rodando duas vezes, a segunda continua respondendo 200, mas o banco guarda **uma** linha.

## Fixtures reais anonimizadas

Veja `apps/api/tests/fixtures/whatsapp/README.md`. Resumo: salve o JSON recebido, rode
`pnpm --filter @megabot/api webhook:anonymize entrada.json apps/api/tests/fixtures/whatsapp/real/nome.json`,
**revise** o resultado e faça commit. Todo arquivo em `real/` passa a ser testado automaticamente.

## Logs e métricas

- Todo log da requisição leva `request_id`; depois de resolver o tenant, o log `request completed` também leva `tenant_id`.
- Eventos de log: `whatsapp.webhook.handled`, `whatsapp.webhook.stored` (por tenant), `whatsapp.webhook.unknown_number`, `whatsapp.webhook.invalid_signature`, `whatsapp.webhook.invalid_payload`.
- Métricas (linhas com `event: "metric"`): `whatsapp_webhook_requests_total{outcome}`, `whatsapp_webhook_events_received_total{tenant_id,kind}`, `whatsapp_webhook_events_stored_total{tenant_id}`, `whatsapp_webhook_events_duplicate_total{tenant_id}`, `whatsapp_webhook_unknown_number_total`, `whatsapp_webhook_duration_ms{outcome}`.
- Nunca são registrados: texto das mensagens, telefones completos, segredos.
