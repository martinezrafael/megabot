# Fundações da API

## Configuração (variáveis de ambiente)

A API valida tudo na inicialização. Se algo estiver errado, o processo **não sobe** e lista todos os problemas.

| Variável                                    | Padrão                                              | Observação                                                   |
| ------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `DATABASE_URL`                              | — (obrigatória)                                     | Use o usuário `megabot_app` (o superusuário ignora o RLS)    |
| `BETTER_AUTH_SECRET`                        | — (obrigatória)                                     | Mínimo 32 caracteres; o valor de exemplo é recusado          |
| `PORT`                                      | `3000`                                              |                                                              |
| `BETTER_AUTH_URL` / `WEB_URL`               | `http://localhost:{PORT}` / `http://localhost:3001` | **Obrigatórias em produção**                                 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | vazias                                              | Opcionais, mas só juntas                                     |
| `SMTP_HOST` / `SMTP_PORT` / `MAIL_FROM`     | `localhost` / `1025` / ...                          | Mailpit em dev                                               |
| `LOG_LEVEL`                                 | `info`                                              | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
| `RATE_LIMIT_WINDOW_SECONDS`                 | `60`                                                |                                                              |
| `RATE_LIMIT_MAX`                            | `300`                                               | Por IP, rotas em geral                                       |
| `RATE_LIMIT_AUTH_MAX`                       | `20`                                                | Por IP, rotas de login/cadastro/reset                        |
| `TRUST_PROXY`                               | `false`                                             | `true`, número de proxies ou `loopback`                      |
| `SWAGGER_ENABLED`                           | `true` em dev, `false` em produção                  | Libera `/docs`                                               |

Web (`apps/web`): `NEXT_PUBLIC_API_URL` (obrigatória no build e na execução em produção) e `API_URL` (opcional, rede interna).

## Formato de erro (todas as rotas)

```json
{
  "statusCode": 401,
  "error": "Unauthorized",
  "message": "Sessão ausente ou expirada",
  "requestId": "0b6d0f3e-5c3b-4d5a-9a52-3f3b6c7d9a10",
  "path": "/me",
  "timestamp": "2026-11-11T11:41:47.835Z",
  "details": {}
}
```

`details` só aparece quando há informação extra (ex.: `/health/ready`). Erros 5xx têm sempre a mensagem genérica; o detalhe fica só no log. A rota `/api/auth/*` devolve os erros no formato do próprio Better Auth.

## Request id

Toda resposta traz `x-request-id`. Se o chamador enviar um `x-request-id` válido (8 a 128 caracteres entre letras, números, `.`, `_` e `-`), ele é reaproveitado; senão a API gera um UUID. O mesmo valor aparece em todos os logs da requisição como `request_id`. O web repassa o id à API.

## Logs

JSON em produção, legível em desenvolvimento. Campos de cada linha "request completed":

| Campo                            | Quando                                                                   |
| -------------------------------- | ------------------------------------------------------------------------ |
| `request_id`                     | sempre                                                                   |
| `tenant_id`, `user_id`           | requisições autenticadas                                                 |
| `req.method`, `req.url`          | sempre (URL **sem** query string e com o token do reset de senha oculto) |
| `res.statusCode`, `responseTime` | sempre                                                                   |

Nível: 2xx/3xx `info`, 4xx `warn`, 5xx `error`. Cookies e `Authorization` nunca são gravados. `/health` não é logado.

## Rate limit

| Balde     | Vale para                           | Limite                |
| --------- | ----------------------------------- | --------------------- |
| `default` | todas as rotas, exceto `/health*`   | `RATE_LIMIT_MAX`      |
| `auth`    | `/api/auth/*`, exceto `get-session` | `RATE_LIMIT_AUTH_MAX` |

Ao exceder: `429` no formato padrão de erro, com `Retry-After`. O limite roda **antes** da checagem de sessão.

## Health

| Rota                | Faz                                                | Resposta                                                         |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /health`       | liveness (não consulta nada externo)               | `200 {"status":"ok"}`                                            |
| `GET /health/ready` | readiness (`SELECT 1` no Postgres, timeout de 2 s) | `200` com `info.database.status = "up"`; `503` se o banco falhar |

## OpenAPI

- Documentação interativa: `GET /docs` (só em desenvolvimento por padrão). JSON: `GET /docs/openapi.json`.
- Arquivo versionado: `apps/api/openapi.json`. Regenere com `pnpm openapi:generate` (também gera `apps/web/src/lib/api/schema.d.ts`) sempre que mudar um controller ou DTO.
- O teste `tests/openapi.test.ts` e o passo "Verify OpenAPI contract is up to date" do CI falham se o arquivo estiver desatualizado.
- Só as rotas de autenticação suportadas entram no contrato.
