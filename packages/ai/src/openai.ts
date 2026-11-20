import { z } from 'zod';
import { AiError, classifyProviderError } from './errors';
import { METRIC, noopLogger, noopMetrics, type AiLogger, type AiMetrics } from './observability';
import { estimateCostUsd, type ModelPricing, type PricingTable } from './pricing';
import { backoffDelay, parseRetryAfter } from './retry';
import { parseToolCalls, toolToJsonSchema, type ToolDefinition } from './tools';
import type {
  AiOperation,
  AiUsageRecord,
  ChatMessage,
  EmbedRequest,
  EmbedResult,
  EmbeddingProvider,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
  TokenUsage,
  UsageRecorder,
} from './types';

export const DEFAULT_BASE_URL = 'https://api.openai.com';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const MAX_EMBEDDING_INPUTS = 2048;

export interface OpenAiProviderOptions {
  /** Chave da API. Nunca é logada nem aparece em erros. */
  apiKey: string;
  /** Modelo de chat padrão (configuração: o ADR 0009 não fixa modelos). */
  chatModel: string;
  /** Modelo de embedding padrão. */
  embeddingModel: string;
  /** Dimensão padrão dos embeddings (opcional; deve casar com o `vector(N)` do banco). */
  embeddingDimensions?: number | undefined;
  baseUrl?: string;
  /** Tempo máximo POR TENTATIVA (ms). Padrão: 30s. */
  timeoutMs?: number;
  /** Repetições internas para falhas transitórias (0 desliga). Padrão: 2 (até 3 chamadas). */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /**
   * Se o `Retry-After` do provedor passar disso, NÃO esperamos aqui: o erro volta com `retryAfterMs`
   * para o job reagendar (não seguramos um worker parado). Padrão: 20s.
   */
  maxRetryAfterMs?: number;
  /** Preços por modelo (USD por 1M de tokens). Sem preço, `costUsd` é `null`. */
  pricing?: PricingTable;
  logger?: AiLogger;
  metrics?: AiMetrics;
  /** Chamado ao fim de TODA chamada lógica (sucesso ou erro) com o consumo. */
  onUsage?: UsageRecorder;
  /** Injetáveis para testes. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

// ---------------------------------------------------------------- respostas da API

const usageSchema = z.looseObject({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  prompt_tokens_details: z
    .looseObject({ cached_tokens: z.number().int().nonnegative().nullish() })
    .nullish(),
});

const chatResponseSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string(),
  usage: usageSchema.nullish(),
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullish(),
        message: z.looseObject({
          content: z.string().nullish(),
          tool_calls: z
            .array(
              z.looseObject({
                id: z.string(),
                function: z.looseObject({ name: z.string(), arguments: z.string().default('') }),
              }),
            )
            .nullish(),
        }),
      }),
    )
    .min(1),
});

const embeddingResponseSchema = z.looseObject({
  model: z.string(),
  usage: usageSchema.nullish(),
  data: z.array(z.looseObject({ index: z.number().int(), embedding: z.array(z.number()) })),
});

const errorBodySchema = z.looseObject({
  error: z
    .looseObject({
      message: z.string().nullish(),
      type: z.string().nullish(),
      code: z.union([z.string(), z.number()]).nullish(),
    })
    .nullish(),
});

// ---------------------------------------------------------------- utilidades

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

function toTokenUsage(raw: z.infer<typeof usageSchema> | null | undefined): TokenUsage {
  if (!raw) return { ...ZERO_USAGE };
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens: Math.min(raw.prompt_tokens_details?.cached_tokens ?? 0, inputTokens),
    outputTokens,
    totalTokens: raw.total_tokens ?? inputTokens + outputTokens,
  };
}

/** Procura o preço pelo modelo que respondeu (versionado), pelo pedido e por prefixo (o mais longo). */
export function findPricing(
  table: PricingTable,
  ...names: Array<string | undefined>
): ModelPricing | undefined {
  const wanted = names.filter((n): n is string => Boolean(n));
  for (const name of wanted) if (table[name]) return table[name];
  let best: string | undefined;
  for (const key of Object.keys(table)) {
    if (wanted.some((n) => n.startsWith(key)) && (!best || key.length > best.length)) best = key;
  }
  return best ? table[best] : undefined;
}

function finishReasonOf(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

function invalidRequest(message: string): AiError {
  return new AiError(message, { category: 'invalid_request', retryable: false });
}

interface CallContext {
  tenantId: string;
  operation: AiOperation;
  /** Modelo pedido; é substituído pelo que o provedor informar. */
  model: string;
  signal?: AbortSignal | undefined;
  /** Preenchidos pela chamada à medida que sabe (para registrar até quando falha depois de gastar tokens). */
  usage: TokenUsage;
  usageKnown: boolean;
  requestId?: string | undefined;
  attempts: number;
}

/**
 * Provedor OpenAI (chat com tool calling + embeddings). Fala HTTP direto (`fetch`), sem SDK:
 * menos dependências e fácil de testar. Um provedor serve a todos os tenants (a chave é da plataforma);
 * o tenant vai em cada requisição, para log, métrica e registro de uso.
 */
export class OpenAiProvider implements LLMProvider, EmbeddingProvider {
  readonly name = 'openai';

  private readonly apiKey: string;
  private readonly chatModel: string;
  private readonly embeddingModel: string;
  private readonly embeddingDimensions: number | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly pricing: PricingTable;
  private readonly logger: AiLogger;
  private readonly metrics: AiMetrics;
  private readonly onUsage: UsageRecorder | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(options: OpenAiProviderOptions) {
    const bad = (message: string) =>
      new AiError(message, { category: 'configuration', retryable: false });
    if (!options.apiKey.trim()) throw bad('apiKey é obrigatória.');
    if (!options.chatModel.trim()) throw bad('chatModel é obrigatório.');
    if (!options.embeddingModel.trim()) throw bad('embeddingModel é obrigatório.');
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw bad('timeoutMs deve ser positivo.');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
      throw bad('maxRetries deve ser um inteiro entre 0 e 10.');
    }

    this.apiKey = options.apiKey;
    this.chatModel = options.chatModel;
    this.embeddingModel = options.embeddingModel;
    this.embeddingDimensions = options.embeddingDimensions;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? 8_000;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? 20_000;
    this.pricing = options.pricing ?? {};
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.onUsage = options.onUsage;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------------ chat

  async generate<const T extends readonly ToolDefinition[] = readonly []>(
    request: GenerateRequest<T>,
  ): Promise<GenerateResult<T>> {
    const tools: readonly ToolDefinition[] = request.tools ?? [];
    const body = this.buildChatBody(request, tools);
    const ctx = this.newContext(request.tenantId, 'generate', body.model as string, request.signal);

    return this.instrument(ctx, async () => {
      const raw = await this.post('/v1/chat/completions', body, ctx);
      const parsed = chatResponseSchema.safeParse(raw);
      if (!parsed.success) throw this.badResponse('chat');
      const data = parsed.data;

      ctx.model = data.model;
      ctx.usage = toTokenUsage(data.usage);
      ctx.usageKnown = Boolean(data.usage);

      const choice = data.choices[0]!;
      const toolCalls = parseToolCalls(
        tools,
        (choice.message.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        })),
      );
      return {
        text: choice.message.content ?? null,
        toolCalls,
        finishReason: finishReasonOf(choice.finish_reason),
        usage: ctx.usage,
        costUsd: this.costOf(ctx),
        model: data.model,
        requestId: ctx.requestId,
      } as GenerateResult<T>;
    });
  }

  private buildChatBody(
    request: GenerateRequest<readonly ToolDefinition[]>,
    tools: readonly ToolDefinition[],
  ): Record<string, unknown> {
    if (request.messages.length === 0) throw invalidRequest('messages não pode ser vazio.');
    if (
      request.temperature !== undefined &&
      !(request.temperature >= 0 && request.temperature <= 2)
    ) {
      throw invalidRequest('temperature deve estar entre 0 e 2.');
    }
    if (
      request.maxOutputTokens !== undefined &&
      !(Number.isInteger(request.maxOutputTokens) && request.maxOutputTokens > 0)
    ) {
      throw invalidRequest('maxOutputTokens deve ser um inteiro positivo.');
    }
    const names = new Set(tools.map((t) => t.name));
    if (names.size !== tools.length) throw invalidRequest('Há ferramentas com o mesmo nome.');

    const body: Record<string, unknown> = {
      model: request.model ?? this.chatModel,
      messages: request.messages.map(toApiMessage),
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxOutputTokens !== undefined) body.max_completion_tokens = request.maxOutputTokens;

    const choice = request.toolChoice;
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: toolToJsonSchema(t) },
      }));
      if (choice !== undefined) {
        if (typeof choice === 'object' && !names.has(choice.name)) {
          throw invalidRequest(
            `toolChoice aponta para uma ferramenta não declarada: "${choice.name}".`,
          );
        }
        body.tool_choice =
          typeof choice === 'object'
            ? { type: 'function', function: { name: choice.name } }
            : choice;
      }
    } else if (choice !== undefined && choice !== 'none') {
      throw invalidRequest('toolChoice exige `tools`.');
    }
    return body;
  }

  // ------------------------------------------------------------------ embeddings

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const n = request.input.length;
    if (n === 0 || n > MAX_EMBEDDING_INPUTS) {
      throw invalidRequest(`input deve ter de 1 a ${MAX_EMBEDDING_INPUTS} textos.`);
    }
    if (request.input.some((text) => !text.trim())) {
      throw invalidRequest('input não pode conter textos vazios.');
    }
    const dimensions = request.dimensions ?? this.embeddingDimensions;
    if (dimensions !== undefined && !(Number.isInteger(dimensions) && dimensions > 0)) {
      throw invalidRequest('dimensions deve ser um inteiro positivo.');
    }

    const body: Record<string, unknown> = {
      model: request.model ?? this.embeddingModel,
      input: request.input,
      encoding_format: 'float',
      ...(dimensions === undefined ? {} : { dimensions }),
    };
    const ctx = this.newContext(request.tenantId, 'embed', body.model as string, request.signal);

    return this.instrument(ctx, async () => {
      const raw = await this.post('/v1/embeddings', body, ctx);
      const parsed = embeddingResponseSchema.safeParse(raw);
      if (!parsed.success) throw this.badResponse('embeddings');
      const data = parsed.data;

      ctx.model = data.model;
      ctx.usage = toTokenUsage(data.usage);
      ctx.usageKnown = Boolean(data.usage);

      const ordered = [...data.data].sort((a, b) => a.index - b.index);
      const consistent =
        ordered.length === n &&
        ordered.every((item, i) => item.index === i) &&
        ordered.every((item) => item.embedding.length === ordered[0]!.embedding.length) &&
        ordered[0]!.embedding.length > 0 &&
        (dimensions === undefined || ordered[0]!.embedding.length === dimensions);
      if (!consistent) throw this.badResponse('embeddings (quantidade, ordem ou dimensão)');

      return {
        embeddings: ordered.map((item) => item.embedding),
        dimensions: ordered[0]!.embedding.length,
        usage: ctx.usage,
        costUsd: this.costOf(ctx),
        model: data.model,
        requestId: ctx.requestId,
      };
    });
  }

  // ------------------------------------------------------------------ infraestrutura

  private newContext(
    tenantId: string,
    operation: AiOperation,
    model: string,
    signal: AbortSignal | undefined,
  ): CallContext {
    if (!tenantId?.trim()) throw invalidRequest('tenantId é obrigatório.');
    return {
      tenantId,
      operation,
      model,
      signal,
      usage: { ...ZERO_USAGE },
      usageKnown: false,
      attempts: 0,
    };
  }

  private costOf(ctx: CallContext): number | null {
    if (!ctx.usageKnown) return null;
    return estimateCostUsd(ctx.usage, findPricing(this.pricing, ctx.model));
  }

  private badResponse(what: string): AiError {
    return new AiError(`Resposta do provedor de IA fora do formato esperado (${what}).`, {
      category: 'invalid_response',
      retryable: false,
    });
  }

  /** Mede, registra (log + métricas + `onUsage`) e propaga o resultado/erro. Nunca registra conteúdo. */
  private async instrument<R>(ctx: CallContext, run: () => Promise<R>): Promise<R> {
    const started = this.now();
    let error: AiError | undefined;
    try {
      return await run();
    } catch (caught) {
      error =
        caught instanceof AiError
          ? caught
          : new AiError('Falha inesperada ao chamar o provedor de IA.', {
              category: 'unknown',
              retryable: false,
              cause: caught,
            });
      error.attempts ??= ctx.attempts;
      throw error;
    } finally {
      await this.finish(ctx, this.now() - started, error);
    }
  }

  private async finish(ctx: CallContext, latencyMs: number, error: AiError | undefined) {
    const outcome = error ? 'error' : 'ok';
    const costUsd = this.costOf(ctx);
    const labels = {
      tenant_id: ctx.tenantId,
      provider: this.name,
      model: ctx.model,
      operation: ctx.operation,
    };
    const record: AiUsageRecord = {
      tenantId: ctx.tenantId,
      provider: this.name,
      model: ctx.model,
      operation: ctx.operation,
      outcome,
      usage: ctx.usage,
      costUsd,
      latencyMs,
      attempts: ctx.attempts,
      requestId: ctx.requestId,
      ...(error ? { errorCategory: error.category } : {}),
    };

    this.metrics.increment(METRIC.requests, {
      ...labels,
      outcome,
      ...(error ? { error_category: error.category } : {}),
    });
    this.metrics.timing(METRIC.requestDuration, latencyMs, labels);
    const tokenKinds = [
      ['input', ctx.usage.inputTokens - ctx.usage.cachedInputTokens],
      ['cached_input', ctx.usage.cachedInputTokens],
      ['output', ctx.usage.outputTokens],
    ] as const;
    for (const [kind, value] of tokenKinds) {
      if (value > 0) this.metrics.increment(METRIC.tokens, { ...labels, kind }, value);
    }
    if (costUsd !== null && costUsd > 0) this.metrics.increment(METRIC.costUsd, labels, costUsd);

    const fields = {
      event: 'ai.call',
      tenant_id: ctx.tenantId,
      provider: this.name,
      model: ctx.model,
      operation: ctx.operation,
      outcome,
      input_tokens: ctx.usage.inputTokens,
      cached_input_tokens: ctx.usage.cachedInputTokens,
      output_tokens: ctx.usage.outputTokens,
      cost_usd: costUsd,
      latency_ms: latencyMs,
      attempts: ctx.attempts,
      request_id: ctx.requestId,
    };
    if (error) {
      // Nada de `providerMessage` aqui: pode repetir trechos do prompt do cliente.
      this.logger[error.retryable ? 'warn' : 'error'](
        {
          ...fields,
          error_category: error.category,
          retryable: error.retryable,
          http_status: error.httpStatus,
          provider_code: error.providerCode,
        },
        'Chamada ao provedor de IA falhou',
      );
    } else {
      this.logger.info(fields, 'Chamada ao provedor de IA concluída');
      if (!ctx.usageKnown) {
        this.logger.warn(
          { event: 'ai.usage_missing', tenant_id: ctx.tenantId, model: ctx.model },
          'O provedor não informou o uso de tokens: custo não calculado',
        );
      }
    }

    if (this.onUsage) {
      try {
        await this.onUsage(record);
      } catch (hookError) {
        // Registrar consumo não pode derrubar uma resposta que já foi paga.
        this.logger.error(
          {
            event: 'ai.usage_recorder_failed',
            tenant_id: ctx.tenantId,
            err: hookError instanceof Error ? hookError.message : 'erro desconhecido',
          },
          'Falha ao registrar o consumo de IA',
        );
      }
    }
  }

  /** POST com timeout por tentativa e retentativa de falhas transitórias. */
  private async post(path: string, body: unknown, ctx: CallContext): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      ctx.attempts = attempt;
      try {
        return await this.once(path, body, ctx);
      } catch (caught) {
        const error = caught as AiError;
        error.attempts = attempt;
        if (!error.retryable || attempt > this.maxRetries || ctx.signal?.aborted) throw error;

        let delay: number;
        if (error.retryAfterMs !== undefined) {
          // O provedor mandou esperar mais do que aceitamos segurar o worker: devolve para o job reagendar.
          if (error.retryAfterMs > this.maxRetryAfterMs) throw error;
          delay = error.retryAfterMs;
        } else {
          delay = backoffDelay(
            attempt,
            { baseDelayMs: this.retryBaseDelayMs, maxDelayMs: this.retryMaxDelayMs },
            this.random,
          );
        }
        this.metrics.increment(METRIC.retries, {
          tenant_id: ctx.tenantId,
          provider: this.name,
          operation: ctx.operation,
          error_category: error.category,
        });
        this.logger.warn(
          {
            event: 'ai.retry',
            tenant_id: ctx.tenantId,
            model: ctx.model,
            operation: ctx.operation,
            attempt,
            delay_ms: delay,
            error_category: error.category,
            http_status: error.httpStatus,
          },
          'Repetindo a chamada ao provedor de IA',
        );
        await this.sleep(delay);
      }
    }
  }

  private async once(path: string, body: unknown, ctx: CallContext): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
      text = await response.text();
    } catch (cause) {
      if (ctx.signal?.aborted) {
        throw new AiError('Chamada ao provedor de IA cancelada.', {
          category: 'aborted',
          retryable: false,
          cause,
        });
      }
      if (timeout.aborted) {
        throw new AiError(`Tempo limite de ${this.timeoutMs} ms excedido na chamada de IA.`, {
          category: 'timeout',
          retryable: true,
          cause,
        });
      }
      throw new AiError('Falha de rede ao chamar o provedor de IA.', {
        category: 'temporary',
        retryable: true,
        cause,
      });
    }

    ctx.requestId = response.headers.get('x-request-id') ?? undefined;

    if (!response.ok) {
      let code: string | undefined;
      let message: string | undefined;
      try {
        const parsed = errorBodySchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.error) {
          code = parsed.data.error.code != null ? String(parsed.data.error.code) : undefined;
          code ??= parsed.data.error.type ?? undefined;
          message = parsed.data.error.message ?? undefined;
        }
      } catch {
        // Corpo não-JSON (ex.: página de erro de gateway): só o status interessa.
      }
      throw classifyProviderError({
        httpStatus: response.status,
        code,
        message,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), this.now()),
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw this.badResponse('corpo não é JSON');
    }
  }
}

function toApiMessage(message: ChatMessage): Record<string, unknown> {
  switch (message.role) {
    case 'system':
    case 'user':
      return { role: message.role, content: message.content };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
              })),
            }
          : {}),
      };
  }
}
