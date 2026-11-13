import { z } from 'zod';

/**
 * Variáveis de ambiente do web, validadas com Zod.
 * É executado por next.config.ts: `next dev`, `next build` e `next start` NÃO
 * sobem com configuração inválida (falha rápida).
 */

const url = z.url({ error: 'precisa ser uma URL válida (ex.: http://localhost:3000)' });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Endereço da API visto pelo NAVEGADOR (embutido no bundle em tempo de build). */
  NEXT_PUBLIC_API_URL: url.optional(),
  /** Endereço da API visto pelo SERVIDOR do Next (rede interna). Se ausente, usa o público. */
  API_URL: url.optional(),
});

export interface WebEnv {
  /** URL da API para o navegador. */
  publicApiUrl: string;
  /** URL da API para Server Components. */
  serverApiUrl: string;
}

export class WebEnvError extends Error {
  constructor(public readonly issues: string[]) {
    super(
      `Configuração inválida do web. Corrija o .env e tente de novo:\n${issues.map((i) => `  - ${i}`).join('\n')}`,
    );
    this.name = 'WebEnvError';
  }
}

export function parseWebEnv(raw: Record<string, string | undefined>): WebEnv {
  // Variável vazia conta como "não definida".
  const cleaned = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = schema.safeParse(cleaned);

  const issues: string[] = [];
  if (!parsed.success) {
    issues.push(
      ...parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || '(geral)'}: ${issue.message}`,
      ),
    );
  } else if (parsed.data.NODE_ENV === 'production' && !parsed.data.NEXT_PUBLIC_API_URL) {
    issues.push('NEXT_PUBLIC_API_URL: obrigatória em produção (defina no build e na execução)');
  }
  if (!parsed.success || issues.length > 0) throw new WebEnvError(issues);

  const publicApiUrl = parsed.data.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
  return { publicApiUrl, serverApiUrl: parsed.data.API_URL ?? publicApiUrl };
}
