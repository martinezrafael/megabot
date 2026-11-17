/**
 * O Prisma aceita `?schema=public` na URL; o driver `pg` (usado pelo pg-boss) passa parâmetros
 * desconhecidos adiante e o Postgres pode rejeitá-los. Aqui removemos o que não é do `pg`.
 */
export function toPgConnectionString(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.delete('schema');
  return url.toString();
}

/** Schema onde o pg-boss instala suas tabelas (ADR 0005). */
export const PGBOSS_SCHEMA = 'pgboss';
