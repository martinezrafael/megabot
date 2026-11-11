import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthContext {
  user: { id: string; email: string; name: string; image?: string | null; emailVerified: boolean };
  session: { id: string; expiresAt: Date };
  /** Tenant ativo do usuário (null só se algo falhou no provisionamento). */
  tenantId: string | null;
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

/** Uso: `@CurrentAuth() auth: AuthContext` num método de controller. */
export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<AuthedRequest>();
  return request.auth;
});
