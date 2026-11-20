# Admin — conexão manual de número do WhatsApp (T1.7)

Rotas **internas**, só para administradores da plataforma (`PLATFORM_ADMIN_EMAILS`), com sessão (cookie).
O token de acesso é cifrado (envelope, [ADR 0018](../adr/0018-token-por-numero-envelope.md)) antes de ir ao banco e **nunca é devolvido nem logado**.
Contrato completo no OpenAPI (`/docs`, tag `admin`).

## `POST /admin/whatsapp/connections`

Liga (ou atualiza) um número a uma empresa.

```json
{
  "tenantId": "uuid da empresa (GET /me → tenant.id)",
  "phoneNumberId": "106540352242922",
  "wabaId": "102290129340398",
  "accessToken": "EAAG...",
  "displayPhoneNumber": "+55 11 99999-0000"
}
```

| Status | Quando                                                                    |
| ------ | ------------------------------------------------------------------------- |
| 201    | Número novo ligado (`created: true`)                                      |
| 200    | Número já era dessa empresa: dados e token atualizados (`created: false`) |
| 400    | Corpo inválido (campos extras também; a mensagem nunca ecoa o token)      |
| 401    | Sem sessão                                                                |
| 403    | Não é administrador da plataforma                                         |
| 404    | Empresa inexistente                                                       |
| 409    | O número já está ligado a **outra** empresa                               |
| 503    | `TOKEN_ENCRYPTION_KEYS` não configurada na API                            |

Resposta (`Cache-Control: no-store`): `{ "created": true, "connection": { id, tenantId, phoneNumberId, wabaId, displayPhoneNumber, hasToken, tokenKeyId, tokenUpdatedAt, createdAt, updatedAt } }` — **sem** o token.

## `GET /admin/whatsapp/connections?tenantId=<uuid>`

Lista as conexões da empresa (mesmo formato, sem token). 400 se `tenantId` inválido.

## Logs e métricas

- `whatsapp.connection.admin` (info/warn) com `tenant_id`, `phone_number_id`, `actor`, `outcome`, `token_key_id`.
- Métrica `whatsapp_connection_admin_total{tenant_id, outcome=created|updated|conflict|tenant_not_found}`.
