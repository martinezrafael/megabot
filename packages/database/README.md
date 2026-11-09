# @megabot/database

Schema, migrations, cliente Prisma e isolamento multitenant via Row Level Security (RLS) do PostgreSQL.

## Modelo

- `tenants`: empresas.
- `users`: usuários.
- `memberships`: vínculo entre usuário e tenant (`role`: `OWNER`, `ADMIN` ou `MEMBER`). **Única tabela com RLS hoje.**

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
