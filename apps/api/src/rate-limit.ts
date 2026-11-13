import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { AppConfig } from './config';

/**
 * Rotas de autenticação (login, cadastro, reset de senha...) recebem um limite
 * mais rígido: são o alvo clássico de força bruta.
 * `get-session` fica de fora porque o front a consulta a cada carregamento de página.
 */
function isStrictAuthRoute(context: ExecutionContext): boolean {
  const request = context.switchToHttp().getRequest<{ path?: string; url?: string }>();
  const path = request.path ?? request.url ?? '';
  return path.startsWith('/api/auth/') && !path.startsWith('/api/auth/get-session');
}

/**
 * Dois "baldes" por IP, ambos na mesma janela de tempo:
 * - default: todas as rotas (exceto as marcadas com @SkipThrottle, como /health)
 * - auth:    só as rotas de autenticação sensíveis, com limite menor
 *
 * O contador fica em memória: vale para UMA instância da API. Com várias
 * instâncias, troque por um storage compartilhado (Redis).
 */
export function createThrottlerOptions(config: AppConfig): ThrottlerModuleOptions {
  const { windowMs, max, authMax } = config.rateLimit;
  return {
    throttlers: [
      { name: 'default', ttl: windowMs, limit: max },
      {
        name: 'auth',
        ttl: windowMs,
        limit: authMax,
        skipIf: (context) => !isStrictAuthRoute(context),
      },
    ],
    errorMessage: 'Muitas requisições. Tente novamente em instantes.',
  };
}
