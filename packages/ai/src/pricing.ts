import { z } from 'zod';
import type { TokenUsage } from './types';

/**
 * Preços em USD por 1 MILHÃO de tokens. Os valores NÃO ficam no código (mudam com frequência, ADR 0009):
 * vêm da configuração (`AI_PRICING_JSON`). Modelo sem preço → custo `null` (nunca inventamos um valor).
 */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Preço dos tokens de entrada em cache. Se ausente, cobra-se como entrada normal. */
  cachedInputPerMillion?: number | undefined;
}

export type PricingTable = Record<string, ModelPricing>;

const price = z.number().nonnegative().finite();
const pricingSchema = z.record(
  z.string().min(1),
  z.strictObject({
    inputPerMillion: price,
    outputPerMillion: price.default(0),
    cachedInputPerMillion: price.optional(),
  }),
);

/** Lê a tabela de preços de um JSON (ex.: `{"modelo-x":{"inputPerMillion":0.5,"outputPerMillion":1.5}}`). */
export function parsePricingTable(json: string | undefined): PricingTable {
  if (!json?.trim()) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('AI_PRICING_JSON não é um JSON válido.');
  }
  const parsed = pricingSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`)
      .join('; ');
    throw new Error(`AI_PRICING_JSON inválido: ${problems}`);
  }
  return parsed.data;
}

const round = (n: number) => Math.round(n * 1e9) / 1e9;

/**
 * Custo ESTIMADO em USD de uma chamada. Estimado porque o provedor pode cobrar de outro jeito
 * (descontos, arredondamentos); serve para acompanhar consumo por tenant, não para faturar.
 */
export function estimateCostUsd(
  usage: Pick<TokenUsage, 'inputTokens' | 'cachedInputTokens' | 'outputTokens'>,
  pricing: ModelPricing | undefined,
): number | null {
  if (!pricing) return null;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  const cachedRate = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;
  const cost =
    (fresh * pricing.inputPerMillion +
      cached * cachedRate +
      usage.outputTokens * pricing.outputPerMillion) /
    1_000_000;
  return round(cost);
}
