import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AGENT_TONES,
  AGENT_TOOLS,
  AgentConfigAlreadyActiveError,
  AgentConfigConflictError,
  AgentConfigInvalidError,
  AgentConfigVersionNotFoundError,
  AgentToolUnavailableError,
  MAX_AGENT_GREETING,
  MAX_AGENT_NAME,
  MAX_AGENT_RULE,
  MAX_AGENT_RULES,
  UnknownAgentToolError,
  getActiveAgentConfigOrDefault,
  getAgentConfigVersion,
  listAgentConfigVersions,
  restoreAgentConfigVersion,
  saveAgentConfig,
  type AgentConfigInput,
  type AgentConfigRecord,
} from '@megabot/database';
import { PinoLogger } from 'nestjs-pino';
import { createLogMetrics } from '../whatsapp/log-metrics';
import type { AgentConfigOptionsDto } from './agent-config.dto';

/** Rótulos: tenant_id e, quando faz sentido, outcome (saved|rejected|conflict) e version. */
export const AGENT_CONFIG_METRIC = {
  saves: 'agent_config_saves_total',
  restores: 'agent_config_restores_total',
} as const;

export interface AgentConfigAuthor {
  userId: string;
}

@Injectable()
export class AgentConfigService {
  constructor(@Inject(PinoLogger) private readonly logger: PinoLogger) {}

  /** Catálogo e limites: a tela monta o formulário com isto, sem repetir rótulos no front. */
  get options(): AgentConfigOptionsDto {
    return {
      tones: AGENT_TONES.map((tone) => ({ ...tone })),
      tools: AGENT_TOOLS.map((tool) => ({ ...tool })),
      maxNameLength: MAX_AGENT_NAME,
      maxGreetingLength: MAX_AGENT_GREETING,
      maxRules: MAX_AGENT_RULES,
      maxRuleLength: MAX_AGENT_RULE,
    };
  }

  private count(name: string, tenantId: string, labels: Record<string, string | number> = {}) {
    createLogMetrics(this.logger).increment(name, { tenant_id: tenantId, ...labels });
  }

  /**
   * Erro de domínio -> resposta HTTP. As mensagens já vêm prontas para a tela mostrar.
   * Nada de conteúdo da configuração aqui: o texto é dado do cliente.
   */
  private rethrow(tenantId: string, metric: string, error: unknown): never {
    if (
      error instanceof AgentConfigInvalidError ||
      error instanceof UnknownAgentToolError ||
      error instanceof AgentToolUnavailableError
    ) {
      this.count(metric, tenantId, { outcome: 'rejected' });
      throw new BadRequestException(error.message);
    }
    if (error instanceof AgentConfigVersionNotFoundError)
      throw new NotFoundException(error.message);
    if (error instanceof AgentConfigAlreadyActiveError) {
      this.count(metric, tenantId, { outcome: 'rejected' });
      throw new ConflictException(error.message);
    }
    if (error instanceof AgentConfigConflictError) {
      this.count(metric, tenantId, { outcome: 'conflict' });
      throw new ConflictException(error.message);
    }
    throw error;
  }

  /** A configuração no ar — ou os padrões, marcados com `version: 0`. */
  active(tenantId: string): Promise<AgentConfigRecord> {
    return getActiveAgentConfigOrDefault(tenantId);
  }

  version(tenantId: string, version: number): Promise<AgentConfigRecord> {
    return getAgentConfigVersion(tenantId, version).catch((error: unknown) =>
      this.rethrow(tenantId, AGENT_CONFIG_METRIC.saves, error),
    );
  }

  history(tenantId: string, page: { limit: number; offset: number }) {
    return listAgentConfigVersions(tenantId, page);
  }

  async save(
    tenantId: string,
    input: AgentConfigInput,
    author: AgentConfigAuthor,
  ): Promise<AgentConfigRecord> {
    try {
      const saved = await saveAgentConfig(tenantId, input, { userId: author.userId });
      this.logger.info(
        {
          event: 'agent_config.saved',
          tenant_id: tenantId,
          version: saved.version,
          tone: saved.tone,
          tools: saved.tools.length,
          rules: saved.rules.length,
          greeting_chars: saved.greeting.length,
        },
        `Configuração do agente salva como versão ${saved.version}`,
      );
      this.count(AGENT_CONFIG_METRIC.saves, tenantId, {
        outcome: 'saved',
        version: saved.version,
      });
      return saved;
    } catch (error) {
      this.rethrow(tenantId, AGENT_CONFIG_METRIC.saves, error);
    }
  }

  async restore(
    tenantId: string,
    version: number,
    author: AgentConfigAuthor,
  ): Promise<AgentConfigRecord> {
    try {
      const restored = await restoreAgentConfigVersion(tenantId, version, {
        userId: author.userId,
      });
      this.logger.info(
        {
          event: 'agent_config.restored',
          tenant_id: tenantId,
          version: restored.version,
          restored_from_version: version,
        },
        `Versão ${version} restaurada como versão ${restored.version}`,
      );
      this.count(AGENT_CONFIG_METRIC.restores, tenantId, {
        outcome: 'saved',
        version: restored.version,
      });
      return restored;
    } catch (error) {
      this.rethrow(tenantId, AGENT_CONFIG_METRIC.restores, error);
    }
  }
}
