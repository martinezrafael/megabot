import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';
import type { Auth } from './auth';
import { AUTH } from './auth.tokens';
import { Public } from './public.decorator';

/**
 * Entrega TODAS as rotas /api/auth/* ao Better Auth.
 *
 * Por ser um controller do Nest (e não uma rota "solta" do Express), estas rotas
 * também passam pelo request id, pelo log, pelo rate limit (mais rígido, ver
 * rate-limit.ts) e pelo filtro de erros. São públicas por natureza: quem decide
 * se há sessão é o próprio Better Auth.
 *
 * Importante: o corpo da requisição NÃO pode ser lido antes (ver jsonUnlessAuth
 * em bootstrap.ts), porque o Better Auth precisa ler o stream cru.
 */
@ApiExcludeController()
@Public()
@Controller('api/auth')
export class AuthController {
  private readonly handler: ReturnType<typeof toNodeHandler>;

  constructor(@Inject(AUTH) auth: Auth) {
    this.handler = toNodeHandler(auth);
  }

  @All('*splat')
  handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.handler(req, res);
  }
}
