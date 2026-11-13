# ADR 0004 — Prisma + PostgreSQL com RLS

- **Status:** Aceita
- **Data:** 2026-11-12
- **Contexto da task:** T0.7 (decisão originada na T0.4)

## Contexto

O produto é multitenant. O isolamento entre clientes não pode depender só de `WHERE tenant_id`
escrito à mão em cada consulta. Também precisaremos de busca vetorial (base de conhecimento) e de
filas (ADR 0005), idealmente sem infraestrutura extra.

## Opções consideradas

| Opção                   | Prós                                                                   | Contras                                           |
| ----------------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| **Prisma + PostgreSQL** | Schema tipado, migrações versionadas, RLS nativa do Postgres, pgvector | Consultas muito específicas exigem SQL cru        |
| Drizzle + PostgreSQL    | SQL mais próximo, leve                                                 | Migrações e ergonomia menos maduras para o time   |
| TypeORM                 | Integra com Nest                                                       | Tipagem mais fraca, manutenção irregular          |
| MongoDB                 | Esquema flexível                                                       | Sem RLS; transações e relacionamentos mais pobres |

## Decisão

- **PostgreSQL 16** (imagem `pgvector/pgvector:pg16`) como único banco.
- **Prisma 7** com `@prisma/adapter-pg`; migrações SQL versionadas em `packages/database`.
- **Row Level Security** com `FORCE ROW LEVEL SECURITY`; o contexto vem das variáveis de sessão
  `app.tenant_id` e `app.user_id`, definidas por transação.
- A aplicação conecta com um usuário **sem** `BYPASSRLS` nem superusuário.

## Justificativa

RLS garante isolamento mesmo se uma consulta esquecer o filtro. Prisma dá tipos e migrações; SQL cru
continua disponível para RLS, índices e pgvector.

## Consequências

- Todo acesso a dados do tenant roda dentro de transação que define `app.tenant_id` (senão retorna vazio).
- Migrações que criam tabelas novas devem incluir políticas RLS e testes de isolamento.
- Cliente gerado precisa de `prisma generate` no build e no CI.
- Banco gerenciado deve suportar a extensão `pgvector` (restrição para o ADR 0008).
