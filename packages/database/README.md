# @megabot/database

Schema, migrations, cliente Prisma e isolamento multitenant via Row Level Security (RLS) do PostgreSQL.

## Modelo

- `tenants`: empresas.
- `users`: usuários.
- `memberships`: vínculo entre usuário e tenant (`role`: `OWNER`, `ADMIN` ou `MEMBER`). Tem RLS.
- `whatsapp_connections`: qual número do WhatsApp (`phone_number_id`, único no sistema) pertence a qual tenant. Tem RLS.
- `webhook_events`: caixa de entrada dos webhooks do WhatsApp, única por `(tenant_id, event_key)`. Tem RLS.
- `contacts`: quem conversa com o tenant, único por `(tenant_id, wa_id)`. Tem RLS.
- `conversations`: **uma janela de 24h** de um contato (`open` | `expired`). No máximo uma `open` por contato (índice parcial). Tem RLS.
- `messages`: mensagens recebidas e enviadas, únicas por `(tenant_id, wamid)`. Tem RLS.

### Conversas (T1.4)

Repositórios em `src/conversations/` (todos usam `withTenant`; "agora" é parâmetro, nada de relógio global):

```ts
import {
  recordInboundMessage,
  prepareOutboundMessage,
  applyStatusUpdate,
  getContactWindow,
} from '@megabot/database';

// Mensagem recebida: abre/renova a janela e grava (reentrega do mesmo wamid é ignorada).
const r = await recordInboundMessage(
  tenantId,
  { waId, wamid, type: 'text', body, sentAt },
  { logger, metrics },
);
// r.window: opened (conta cota) | renewed | unchanged | late_attached | late_expired | duplicate

// Antes de enviar (no worker): checa a janela NA HORA; fora dela lança WindowClosedError (não repetível).
const out = await prepareOutboundMessage(tenantId, {
  contactId,
  sender: 'bot',
  type: 'text',
  body,
});

// Status da Meta (sent/delivered/read/failed): só avança; fora de ordem é ignorado.
await applyStatusUpdate(tenantId, { wamid, status: 'delivered', at });
```

Regras completas: [ADR 0015](../../docs/adr/0015-modelo-de-conversas.md) e [ADR 0010](../../docs/adr/0010-janela-de-conversa-24h.md).

### Decisão de acionar o agente (T1.5)

```ts
import { decideAgentTrigger, getTenantGate, getConversationQuotaPosition } from '@megabot/database';

const gate = await getTenantGate(tenantId); // { status, conversationLimitPerMonth } (null = sem limite)
const position = await getConversationQuotaPosition(tenantId, conversationId); // 1 = 1ª conversa do mês
const { trigger, reason } = decideAgentTrigger({
  tenantStatus: gate.status,
  messageType: 'text',
  windowOpen: true,
  quotaLimit: gate.conversationLimitPerMonth,
  quotaPosition: position,
});
// reason: ok | tenant_inactive | window_expired | unsupported_type | quota_exceeded
```

O job que usa tudo isto está em `apps/worker/src/handlers/inbound-message.ts` ([ADR 0016](../../docs/adr/0016-job-inbound-message.md)).

### Envio (T1.6)

```ts
import {
  getOutboundMessageForSend,
  findTenantWhatsappNumber,
  takeWhatsappSendToken,
} from '@megabot/database';

const msg = await getOutboundMessageForSend(tenantId, messageId); // mensagem de saída + número (waId) do contato
const number = await findTenantWhatsappNumber(tenantId); // { phoneNumberId, wabaId }
const slot = await takeWhatsappSendToken(tenantId, number.phoneNumberId, { ratePerSecond: 80 });
// { allowed: true } | { allowed: false, retryAfterMs }  (balde de fichas por número, vale para todos os workers)
```

A tabela `whatsapp_rate_limits` (uma linha por número, com RLS) guarda o balde. Quem usa tudo isto é o job `whatsapp.outbound` ([ADR 0017](../../docs/adr/0017-envio-e-status.md)).

> Decisão de escopo: `tenants` e `users` não têm RLS. Qualquer sessão com acesso ao banco consegue listá-las. Ao criar tabelas que pertencem a um tenant, siga o checklist da seção "Adicionando RLS a uma nova tabela".

## Como o isolamento funciona

O isolamento tem quatro peças que dependem umas das outras.

**1. Role da aplicação sem privilégios.** A aplicação conecta como `megabot_app`, que não é superuser e não tem `BYPASSRLS`. Superusers e roles com `BYPASSRLS` ignoram qualquer policy. Se a aplicação ou os testes conectarem como `postgres`, o RLS parece configurado mas não isola nada.

**2. Função `current_tenant_id()`.** Lê a variável de sessão `app.tenant_id` e devolve o UUID. Se a variável não existe, está vazia ou é inválida, devolve `NULL`.

**3. Policy `tenant_isolation_policy`.** Em `memberships`, para todas as operações:

```sql
USING (tenant_id = current_tenant_id())
WITH CHECK (tenant_id = current_tenant_id())
```

`USING` filtra o que pode ser lido, alterado ou removido. `WITH CHECK` barra a escrita de linhas de outro tenant. Como `tenant_id = NULL` nunca é verdadeiro, **uma consulta sem contexto de tenant não retorna nada**. A tabela também usa `FORCE ROW LEVEL SECURITY`, então o dono da tabela também fica sujeito à policy.

**4. Helper `withTenant`.** Abre uma transação do Prisma e executa `set_config('app.tenant_id', <id>, true)`. O terceiro argumento `true` torna a configuração **local à transação**: ela desaparece no commit ou rollback, então não vaza entre requisições que reaproveitam a mesma conexão do pool. O helper valida o formato do UUID antes de abrir a transação.

## Como usar

Todo acesso a tabelas com RLS passa por `withTenant`:

```ts
import { withTenant } from '@megabot/database';

const memberships = await withTenant(tenantId, (tx) => tx.membership.findMany());
```

Regras:

- Repositórios usam **sempre** o `tx` recebido no callback, nunca o `prisma` direto.
- Consultar com `prisma` direto devolve vazio, e escrever falha pela policy. Isso é intencional.
- Não faça chamadas externas demoradas dentro do callback, porque a transação fica aberta.

## Comandos

Execute da raiz do repositório.

| Comando                                          | O que faz                               |
| ------------------------------------------------ | --------------------------------------- |
| `pnpm db:generate`                               | Gera o Prisma Client                    |
| `pnpm db:migrate`                                | Aplica as migrations (`migrate deploy`) |
| `pnpm --filter @megabot/database db:migrate:dev` | Cria e aplica uma nova migration em dev |
| `pnpm --filter @megabot/database test`           | Roda o teste de isolamento              |

O Prisma não gera RLS. As policies vivem em migrations SQL escritas à mão (`prisma/migrations/*_enable_rls/migration.sql`).

## Teste de isolamento

`tests/integration/rls-tenant-isolation.test.ts` roda no CI e bloqueia o merge se falhar. Cenários:

1. O Tenant A enxerga apenas os memberships do Tenant A.
2. O Tenant B enxerga apenas os memberships do Tenant B.
3. O Tenant A não consegue buscar registros do Tenant B.
4. Consulta sem contexto de tenant retorna vazio.
5. Inserir membership em nome de outro tenant é rejeitado.

O teste usa o `DATABASE_URL` do `.env` (via `node --env-file`) e, ao final, executa `TRUNCATE` em `memberships`, `users` e `tenants`. **Nunca aponte para um banco com dados reais.**

## Rollback do RLS

Cada migration de RLS tem um `rollback.sql` ao lado. O Prisma ignora esse arquivo, então a execução é manual:

```bash
# 1. Aplicar o rollback
docker exec -i megabot_postgres psql -U postgres -d megabot -v ON_ERROR_STOP=1 \
  < packages/database/prisma/migrations/20261108173323_enable_rls/rollback.sql

# 2. Conferir a reversão (esperado: policies = 0, flags f | f, função = 0)
docker exec -i megabot_postgres psql -U postgres -d megabot \
  -c "SELECT count(*) FROM pg_policies WHERE tablename = 'memberships';" \
  -c "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'memberships';" \
  -c "SELECT count(*) FROM pg_proc WHERE proname = 'current_tenant_id';"

# 3. Rodar o teste: deve FALHAR (sem RLS há vazamento entre tenants)
pnpm --filter @megabot/database test

# 4. Reaplicar a migration (é idempotente) e rodar o teste de novo: deve passar
docker exec -i megabot_postgres psql -U postgres -d megabot -v ON_ERROR_STOP=1 \
  < packages/database/prisma/migrations/20261108173323_enable_rls/migration.sql
pnpm --filter @megabot/database test
```

A tabela `_prisma_migrations` não muda nesse ciclo. Para validar do zero, use `pnpm db:reset` seguido de `pnpm db:migrate`. O CI executa o rollback e verifica o resultado a cada execução.

## Adicionando RLS a uma nova tabela

1. A tabela precisa ter a coluna `tenant_id UUID NOT NULL`, com índice.
2. Crie uma migration SQL com `ENABLE` e `FORCE ROW LEVEL SECURITY` e uma policy com `USING` e `WITH CHECK` usando `current_tenant_id()`.
3. Escreva o `rollback.sql` correspondente (`DROP POLICY`, `NO FORCE`, `DISABLE`).
4. Dê ao `megabot_app` apenas os `GRANT`s necessários.
5. Acrescente cenários ao teste de isolamento: leitura cruzada, consulta sem contexto e escrita cruzada.
6. Acesse a tabela somente via `withTenant`.

---

## Descobrindo o tenant de um usuário (login) e criando o tenant (cadastro)

A policy `tenant_isolation_policy` só mostra memberships do tenant em `app.tenant_id`. No login ainda não
sabemos o tenant, então existe uma **segunda policy, só de SELECT**: `membership_self_select_policy`, que
libera as memberships do **próprio usuário** informado em `app.user_id` (função `current_app_user_id()`).
As policies permissivas são combinadas com OR; INSERT/UPDATE/DELETE continuam presos ao tenant.

> Por que não uma função `SECURITY DEFINER`? Como `memberships` usa `FORCE ROW LEVEL SECURITY` e o dono da
> tabela é o mesmo usuário da aplicação (`megabot_app`), a função também seria barrada pelo RLS.

| Helper                                             | Para que serve                                                                          |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `withTenant(tenantId, fn)`                         | Trabalhar DENTRO de um tenant (uso normal)                                              |
| `withUser(userId, fn)` / `listUserTenants(userId)` | Descobrir a quais tenants o usuário pertence                                            |
| `provisionTenantForUser(user)`                     | Criar tenant + membership `OWNER` no primeiro cadastro (idempotente, com advisory lock) |

Ao criar o tenant, `provisionTenantForUser` define `app.tenant_id` com o UUID do tenant **novo** antes de
inserir a membership; sem isso o `WITH CHECK` da policy bloqueia o INSERT.

## Build do pacote

`pnpm --filter @megabot/database build` gera o Prisma Client e compila `src/` para `dist/` (CommonJS), que é o
que a API usa em runtime. Os testes e o typecheck continuam usando `src/` diretamente.

---

## WhatsApp: descobrindo o tenant pelo número e gravando webhooks

O webhook da Meta só traz o `phone_number_id`: ainda não sabemos o tenant. Mesmo padrão da seção anterior, uma segunda policy de **só leitura**:

- `whatsapp_connection_lookup_policy` libera o SELECT da conexão cujo número está em `app.phone_number_id` (função `current_app_phone_number_id()`). Dá para ler UMA linha por vez, nunca listar as de todos os tenants.
- `findWhatsappConnectionByPhoneNumberId(phoneNumberId)` é o único ponto que usa essa policy. Devolve `{ tenantId, wabaId }` ou `null`.
- `storeWebhookEvents(tenantId, events)` grava via `withTenant` com `createMany({ skipDuplicates: true })` (`ON CONFLICT DO NOTHING`). Devolve quantos foram inseridos e quantos eram duplicados.
- `registerWhatsappConnection(tenantId, ...)` liga um número a um tenant. Enquanto não existe tela para isso: `pnpm db:whatsapp-connect --tenant <uuid> --phone-number-id <id> --waba-id <id>`.

**Chave de idempotência (`event_key`):** `message:<wamid>`, `status:<wamid>:<status>` (o mesmo wamid recebe sent, delivered e read) ou `error:<uuid>` (erros de sistema não têm id). **Ordem real:** use `event_at` (hora da Meta); `received_at` é só a ordem de chegada.

Testes: `tests/integration/whatsapp-webhook.test.ts`. Rollback: `prisma/migrations/20261115150000_whatsapp_webhook/rollback.sql` (rode **antes** dos rollbacks das migrations anteriores).
