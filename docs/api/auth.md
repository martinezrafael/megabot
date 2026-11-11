# Contrato da API — Autenticação

Base URL (dev): `http://localhost:3000`. Todas as rotas `/api/auth/*` são atendidas pelo
[Better Auth](https://www.better-auth.com). Requisições do navegador devem enviar
`credentials: 'include'` e a `Origin` precisa ser o `WEB_URL` configurado (CORS e CSRF).

## Sessão

Cookie `better-auth.session_token` (httpOnly, `SameSite=Lax`), criado no login e na
verificação de e-mail. Em rotas protegidas, ausência/expiração do cookie gera **401**.

## Rotas de autenticação (Better Auth)

| Método | Rota                                          | Corpo                                     | Resposta                                                                        |
| ------ | --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| POST   | `/api/auth/sign-up/email`                     | `{ name, email, password, callbackURL? }` | 200. Envia e-mail de verificação. **Não** cria sessão                           |
| GET    | `/api/auth/verify-email?token&callbackURL`    | —                                         | 302 para `callbackURL`, cria a sessão                                           |
| POST   | `/api/auth/send-verification-email`           | `{ email, callbackURL? }`                 | 200. Reenvia a verificação                                                      |
| POST   | `/api/auth/sign-in/email`                     | `{ email, password }`                     | 200 + cookie. **403** `EMAIL_NOT_VERIFIED`, **401** `INVALID_EMAIL_OR_PASSWORD` |
| POST   | `/api/auth/sign-in/social`                    | `{ provider: 'google', callbackURL }`     | 200 `{ url }` (redirecionar o navegador para o Google)                          |
| GET    | `/api/auth/callback/google`                   | (usado pelo Google)                       | 302 para `callbackURL`, cria a sessão                                           |
| POST   | `/api/auth/request-password-reset`            | `{ email, redirectTo }`                   | 200 sempre (não revela se o e-mail existe)                                      |
| GET    | `/api/auth/reset-password/:token?callbackURL` | —                                         | 302 para `redirectTo?token=...` (ou `?error=INVALID_TOKEN`)                     |
| POST   | `/api/auth/reset-password`                    | `{ newPassword, token }`                  | 200                                                                             |
| POST   | `/api/auth/sign-out`                          | `{}`                                      | 200. Invalida a sessão                                                          |
| GET    | `/api/auth/get-session`                       | —                                         | 200 `{ session, user }` ou `null`                                               |

Regras: senha com no mínimo 8 caracteres (`PASSWORD_TOO_SHORT`, 400); e-mail obrigatoriamente
verificado antes do primeiro login com senha. Contas Google já entram verificadas.

## Rotas da aplicação

Todas exigem sessão (guard global), exceto as marcadas com `@Public()`.

### `GET /health` (público)

`200 { "status": "ok" }`

### `GET /me`

`200`

```json
{
  "user": {
    "id": "uuid",
    "email": "ana@exemplo.com",
    "name": "Ana",
    "image": null,
    "emailVerified": true
  },
  "tenant": { "id": "uuid", "role": "OWNER" }
}
```

`401` sem sessão válida. `tenant` é o primeiro (mais antigo) tenant do usuário.

## Provisionamento de tenant

No primeiro cadastro (senha ou Google) é criado `Tenant` ("Empresa de <nome>") e uma
`Membership` com papel `OWNER`. A operação é idempotente e segura sob concorrência
(`provisionTenantForUser`, em `packages/database`).

## Migrações (todas com rollback manual)

| Migration                                                                                                       | Rollback                      |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `20261110200000_auth_tables` (colunas em `users`, tabelas `sessions`, `accounts`, `verifications`)              | `rollback.sql` na mesma pasta |
| `20261110200100_memberships_user_lookup` (policy `membership_self_select_policy`, função `current_app_user_id`) | `rollback.sql` na mesma pasta |

Aplique os rollbacks na **ordem inversa** das migrations.
