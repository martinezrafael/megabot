import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { ErrorResponseDto } from '../common/error-response.dto';
import { WebhookAckDto } from './whatsapp-webhook.dto';
import { WhatsappWebhookService } from './whatsapp-webhook.service';

/**
 * Porta de entrada dos webhooks da WhatsApp Cloud API.
 *
 * - @Public: a Meta não tem sessão; a autenticidade vem da assinatura (POST) e do token (GET).
 * - @SkipThrottle: o limite por IP é para usuários. A Meta pode mandar rajadas legítimas de poucos
 *   IPs; quem não assina corretamente é recusado em microssegundos (HMAC) e o corpo é limitado a 3 MB.
 */
@ApiTags('webhooks')
@Public()
@SkipThrottle()
@Controller('webhooks/whatsapp')
export class WhatsappWebhookController {
  constructor(@Inject(WhatsappWebhookService) private readonly service: WhatsappWebhookService) {}

  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOperation({
    summary: 'Verificação do webhook (handshake da Meta)',
    description:
      'A Meta chama este endereço ao cadastrar o webhook. Se `hub.verify_token` confere com ' +
      '`WHATSAPP_VERIFY_TOKEN`, devolve `hub.challenge` em texto puro.',
  })
  @ApiQuery({ name: 'hub.mode', required: true, example: 'subscribe' })
  @ApiQuery({ name: 'hub.verify_token', required: true })
  @ApiQuery({ name: 'hub.challenge', required: true, example: '1158201444' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ description: 'O próprio `hub.challenge`', schema: { type: 'string' } })
  @ApiResponse({ status: 403, type: ErrorResponseDto, description: 'Token inválido' })
  verify(@Query() query: Record<string, unknown>): string {
    const challenge = this.service.verifyChallenge(query);
    if (challenge === null) throw new ForbiddenException('Token de verificação inválido.');
    return challenge;
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Recebe eventos do WhatsApp (mensagens e status)',
    description:
      'Confere `X-Hub-Signature-256`, descobre o tenant pelo `phone_number_id`, grava os eventos ' +
      '(idempotente por wamid) e responde 200. O processamento pesado acontece depois, no worker.',
  })
  @ApiHeader({
    name: 'x-hub-signature-256',
    required: true,
    description: '`sha256=` + HMAC-SHA256 do corpo cru com o app secret da Meta',
  })
  @ApiBody({
    description: 'Payload do webhook da WhatsApp Cloud API (`object: whatsapp_business_account`)',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiOkResponse({ type: WebhookAckDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: 'Payload inválido' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Assinatura inválida' })
  @ApiResponse({ status: 503, type: ErrorResponseDto, description: 'Webhook não configurado' })
  async receive(
    @Req() request: Request,
    @Headers('x-hub-signature-256') signature?: string,
  ): Promise<WebhookAckDto> {
    // O bootstrap entrega o corpo CRU (Buffer) nesta rota; sem corpo, o body-parser deixa vazio.
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    await this.service.handle(rawBody, signature);
    return { status: 'ok' };
  }
}
