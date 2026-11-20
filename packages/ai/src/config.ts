import { z } from 'zod';
import { OpenAiProvider, type OpenAiProviderOptions } from './openai';
import { parsePricingTable, type PricingTable } from './pricing';

/** Configuração inválida/ausente: lista todos os problemas de uma vez (falha rápida na subida). */
export class AiConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Configuração de IA inválida:\n - ${issues.join('\n - ')}`);
    this.name = 'AiConfigError';
  }
}

export interface AiConfig {
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions?: number | undefined;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  pricing: PricingTable;
}

const envSchema = z.object({
  OPENAI_API_KEY: z.string({ error: 'obrigatória' }).trim().min(1, 'obrigatória'),
  // Sem padrão de propósito: modelos e preços mudam (ADR 0009) e ficam em configuração.
  AI_CHAT_MODEL: z
    .string({ error: 'obrigatório (o modelo de chat escolhido)' })
    .trim()
    .min(1, 'obrigatório (o modelo de chat escolhido)'),
  AI_EMBEDDING_MODEL: z
    .string({ error: 'obrigatório (o modelo de embedding escolhido)' })
    .trim()
    .min(1, 'obrigatório (o modelo de embedding escolhido)'),
  AI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(8192).optional(),
  AI_BASE_URL: z.url().default('https://api.openai.com'),
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  AI_PRICING_JSON: z.string().optional(),
});

/** Lê a configuração do ambiente. Strings vazias contam como ausentes (como no `.env.example`). */
export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([, v]) => v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  const issues: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || 'env'}: ${issue.message}`);
    }
  }
  let pricing: PricingTable = {};
  try {
    pricing = parsePricingTable(cleaned.AI_PRICING_JSON);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'AI_PRICING_JSON inválido');
  }
  if (!parsed.success || issues.length > 0) throw new AiConfigError(issues);

  const e = parsed.data;
  return {
    apiKey: e.OPENAI_API_KEY,
    chatModel: e.AI_CHAT_MODEL,
    embeddingModel: e.AI_EMBEDDING_MODEL,
    embeddingDimensions: e.AI_EMBEDDING_DIMENSIONS,
    baseUrl: e.AI_BASE_URL,
    timeoutMs: e.AI_TIMEOUT_MS,
    maxRetries: e.AI_MAX_RETRIES,
    pricing,
  };
}

/** Monta o provedor a partir da configuração; `extra` injeta logger, métricas, `onUsage`, etc. */
export function createOpenAiProvider(
  config: AiConfig,
  extra: Partial<OpenAiProviderOptions> = {},
): OpenAiProvider {
  return new OpenAiProvider({
    apiKey: config.apiKey,
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
    embeddingDimensions: config.embeddingDimensions,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    pricing: config.pricing,
    ...extra,
  });
}
