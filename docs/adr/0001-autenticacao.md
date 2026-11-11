# ADR 0001 — Provedor de autenticação

- **Status:** Aceita
- **Data:** 2026-11-10
- **Contexto da task:** T0.5 (história A1)

## Contexto

Precisamos de cadastro, login, e-mail verificado, login com Google e recuperação de
senha. O sistema é multitenant, com isolamento por RLS no PostgreSQL (T0.4), API em
NestJS e front-end em Next.js.

## Opções consideradas

| Opção                         | Prós                                                                                                               | Contras                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| **Better Auth (self-hosted)** | Usuários no nosso Postgres (via Prisma); sem custo por usuário; integra com Nest e Next; hooks para criar o tenant | Nós enviamos os e-mails e cuidamos da operação                                                               |
| Clerk / Auth0 (gerenciado)    | Pronto rápido, UI e e-mails inclusos                                                                               | Usuários fora do nosso banco (exige sincronização por webhook); custo por usuário ativo; dependência externa |
| Supabase Auth                 | Maduro                                                                                                             | Só faz sentido se usarmos o Supabase como banco                                                              |

## Decisão

Usar **Better Auth** dentro da API (NestJS), com o adaptador do Prisma.

- A API é a única dona da autenticação (`/api/auth/*`). O web (Next.js) apenas consome.
- Sessão por **cookie httpOnly** validado no banco a cada requisição.
- O tenant é criado por um _hook_ no momento em que o usuário é criado
  (`databaseHooks.user.create.after`), valendo para cadastro com senha e com Google.

## Consequências

- (+) Usuários, sessões e tenants no mesmo banco; fácil de testar de ponta a ponta.
- (+) Sem custo por usuário.
- (−) Precisamos operar o envio de e-mail (SMTP) e guardar `BETTER_AUTH_SECRET`.
- (−) Better Auth é ESM-only; a API é CommonJS e depende do `require(esm)` do Node ≥ 22.12
  (por isso a imagem Docker da API usa Node 22).
- (−) `memberships` tem RLS por tenant; para descobrir o tenant de quem acabou de logar
  foi necessária uma segunda policy de leitura baseada em `app.user_id`
  (migration `memberships_user_lookup`).
