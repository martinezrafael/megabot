import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  MAX_AGENT_GREETING,
  MAX_AGENT_NAME,
  MAX_AGENT_RULE,
  MAX_AGENT_RULES,
  type AgentConfigRecord,
} from '@megabot/database';
import { z } from 'zod';
import { type AuthContext, CurrentAuth } from '../auth/auth.context';
import { ErrorResponseDto } from '../common/error-response.dto';
import { parseOrBadRequest } from '../common/parse-or-bad-request';
import {
  AgentConfigDto,
  AgentConfigOptionsDto,
  AgentConfigVersionPageDto,
  SaveAgentConfigBodyDto,
} from './agent-config.dto';
import { AgentConfigService } from './agent-config.service';

/**
 * Corpo do salvamento. O Zod cuida de FORMA e TAMANHO; o que é regra de negócio (tom que existe,
 * ferramenta que existe e está disponível) é conferido no pacote database, que é quem grava.
 */
const saveBody = z.strictObject({
  name: z.string().trim().min(1, 'informe o nome do assistente').max(MAX_AGENT_NAME),
  tone: z.enum(['formal', 'neutro', 'amigavel', 'descontraido'], { error: 'tom inválido' }),
  greeting: z.string().trim().min(1, 'escreva a apresentação').max(MAX_AGENT_GREETING),
  tools: z.array(z.string().trim().min(1).max(60)).max(20),
  // Itens vazios são aceitos aqui e descartados na gravação: a tela deixa a pessoa abrir uma
  // linha de regra e só depois digitar.
  rules: z.array(z.string().max(MAX_AGENT_RULE)).max(MAX_AGENT_RULES * 2),
});

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const versionParam = z.coerce
  .number({ error: 'versão inválida' })
  .int('versão inválida')
  .min(1, 'versão inválida');

const toDto = (config: AgentConfigRecord, activeVersion: number): AgentConfigDto => ({
  version: config.version,
  name: config.name,
  tone: config.tone,
  greeting: config.greeting,
  tools: config.tools,
  rules: config.rules,
  createdByName: config.createdByName,
  restoredFromVersion: config.restoredFromVersion,
  createdAt: config.version === 0 ? null : config.createdAt.toISOString(),
  active: config.version === activeVersion,
});

/**
 * Configuração do agente do tenant logado (T2.4).
 *
 * Como no resto da API, o `tenantId` vem SEMPRE da sessão — nunca do corpo ou da URL —, então um
 * cliente não consegue nem tentar ler ou mexer na configuração de outro.
 *
 * A tabela é append-only: salvar cria uma versão nova e restaurar também. A versão que o agente
 * usa é sempre a de maior número.
 */
@ApiTags('agent-config')
@ApiCookieAuth('session')
@Controller('agent-config')
@ApiResponse({ status: 401, type: ErrorResponseDto, description: 'Sem sessão válida' })
@ApiResponse({ status: 403, type: ErrorResponseDto, description: 'Conta sem empresa associada' })
export class AgentConfigController {
  constructor(@Inject(AgentConfigService) private readonly service: AgentConfigService) {}

  private tenantOf(auth: AuthContext): string {
    if (!auth.tenantId) {
      throw new ForbiddenException('Sua conta ainda não tem uma empresa associada.');
    }
    return auth.tenantId;
  }

  @Get('options')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Tons, catálogo de ferramentas e limites dos campos',
    description:
      'A tela monta o formulário a partir daqui. Ferramenta com status `em_breve` não pode ser habilitada.',
  })
  @ApiOkResponse({ type: AgentConfigOptionsDto })
  options(): AgentConfigOptionsDto {
    return this.service.options;
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'A configuração que está no ar',
    description:
      'Quando a empresa nunca salvou nada, devolve os valores padrão com `version: 0` e `createdAt: null`.',
  })
  @ApiOkResponse({ type: AgentConfigDto })
  async current(@CurrentAuth() auth: AuthContext): Promise<AgentConfigDto> {
    const config = await this.service.active(this.tenantOf(auth));
    return toDto(config, config.version);
  }

  @Put()
  @ApiOperation({
    summary: 'Salvar a configuração (cria uma versão nova)',
    description:
      'Cada salvamento insere uma versão; nada é sobrescrito. A versão nova entra no ar na hora.',
  })
  @ApiBody({ type: SaveAgentConfigBodyDto })
  @ApiOkResponse({ type: AgentConfigDto })
  @ApiResponse({
    status: 400,
    type: ErrorResponseDto,
    description: 'Campo inválido, tom inexistente ou ferramenta indisponível',
  })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Outra pessoa salvou no mesmo instante',
  })
  async save(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<AgentConfigDto> {
    const tenantId = this.tenantOf(auth);
    const input = parseOrBadRequest(saveBody, body);
    const saved = await this.service.save(tenantId, input, { userId: auth.user.id });
    return toDto(saved, saved.version);
  }

  @Get('versions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Histórico de versões, da mais nova para a mais antiga' })
  @ApiQuery({ name: 'limit', required: false, example: 20 })
  @ApiQuery({ name: 'offset', required: false, example: 0 })
  @ApiOkResponse({ type: AgentConfigVersionPageDto })
  async history(
    @CurrentAuth() auth: AuthContext,
    @Query() query: Record<string, unknown>,
  ): Promise<AgentConfigVersionPageDto> {
    const page = parseOrBadRequest(pageQuery, query);
    const { total, activeVersion, items } = await this.service.history(this.tenantOf(auth), page);
    return { total, activeVersion, items: items.map((item) => toDto(item, activeVersion)) };
  }

  @Get('versions/:version')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'O conteúdo de uma versão' })
  @ApiOkResponse({ type: AgentConfigDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Versão não encontrada' })
  async one(
    @CurrentAuth() auth: AuthContext,
    @Param('version') version: string,
  ): Promise<AgentConfigDto> {
    const tenantId = this.tenantOf(auth);
    const wanted = parseOrBadRequest(versionParam, version);
    const [config, { activeVersion }] = await Promise.all([
      this.service.version(tenantId, wanted),
      this.service.history(tenantId, { limit: 1, offset: 0 }),
    ]);
    return toDto(config, activeVersion);
  }

  @Post('versions/:version/restore')
  @HttpCode(201)
  @ApiOperation({
    summary: 'Restaurar uma versão (rollback)',
    description:
      'Copia o conteúdo da versão informada para uma versão NOVA, que entra no ar. O histórico ' +
      'não é reescrito: o rollback aparece nele, com `restoredFromVersion` apontando para a origem.',
  })
  @ApiCreatedResponse({ type: AgentConfigDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'Versão não encontrada' })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: 'Essa versão já é a que está no ar',
  })
  async restore(
    @CurrentAuth() auth: AuthContext,
    @Param('version') version: string,
  ): Promise<AgentConfigDto> {
    const tenantId = this.tenantOf(auth);
    const wanted = parseOrBadRequest(versionParam, version);
    const restored = await this.service.restore(tenantId, wanted, { userId: auth.user.id });
    return toDto(restored, restored.version);
  }
}
