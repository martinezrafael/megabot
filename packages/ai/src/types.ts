import type { ToolCallOf, ToolDefinition } from './tools';

// ------------------------------------------------------------------ mensagens

/** Chamada de ferramenta feita pelo assistente (para reenviar o histórico ao modelo). */
export interface AssistantToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: readonly AssistantToolCall[] }
  /** Resultado de uma ferramenta, respondendo a `toolCalls[].id`. */
  | { role: 'tool'; toolCallId: string; content: string };

// ------------------------------------------------------------------ uso e custo

export interface TokenUsage {
  inputTokens: number;
  /** Parte de `inputTokens` servida do cache do provedor (mais barata). */
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type AiOperation = 'generate' | 'embed';

/** Registro de UMA chamada lógica (inclui as repetições internas). Nunca contém o conteúdo. */
export interface AiUsageRecord {
  tenantId: string;
  provider: string;
  model: string;
  operation: AiOperation;
  outcome: 'ok' | 'error';
  usage: TokenUsage;
  /**
   * Custo estimado em USD; `null` se o modelo não tem preço configurado ou o provedor não informou o
   * uso. Uma chamada que gastou tokens mas devolveu algo inutilizável (outcome `error`) também tem custo.
   */
  costUsd: number | null;
  latencyMs: number;
  /** Chamadas HTTP feitas (1 = sem repetição). */
  attempts: number;
  errorCategory?: string;
  /** `x-request-id` do provedor, para abrir chamado/suporte. */
  requestId?: string | undefined;
}

/** Gancho para persistir/enviar o consumo (ex.: gravar por tenant). Falha aqui nunca derruba a chamada. */
export type UsageRecorder = (record: AiUsageRecord) => void | Promise<void>;

// ------------------------------------------------------------------ chat (LLM)

export interface GenerateRequest<T extends readonly ToolDefinition[] = readonly []> {
  /** Tenant dono da chamada: vai em todo log, métrica e registro de uso. */
  tenantId: string;
  messages: readonly ChatMessage[];
  tools?: T;
  /** `auto` (padrão): o modelo decide. `required`: deve chamar alguma. `{ name }`: força uma. */
  toolChoice?: 'auto' | 'none' | 'required' | { name: T[number]['name'] };
  /** Sobrescreve o modelo padrão da configuração. */
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Cancela a chamada (ex.: desligamento do worker). */
  signal?: AbortSignal;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'other';

export interface GenerateResult<T extends readonly ToolDefinition[] = readonly []> {
  /** Texto da resposta (pode ser `null` quando o modelo só chamou ferramentas). */
  text: string | null;
  /** Chamadas de ferramenta, validadas e tipadas conforme `tools`. */
  toolCalls: Array<ToolCallOf<T[number]>>;
  finishReason: FinishReason;
  usage: TokenUsage;
  costUsd: number | null;
  /** Modelo que efetivamente respondeu. */
  model: string;
  requestId?: string | undefined;
}

export interface LLMProvider {
  readonly name: string;
  generate<const T extends readonly ToolDefinition[] = readonly []>(
    request: GenerateRequest<T>,
  ): Promise<GenerateResult<T>>;
}

// ------------------------------------------------------------------ embeddings

export interface EmbedRequest {
  tenantId: string;
  /** Textos a vetorizar (1 a 2048). Textos vazios são recusados. */
  input: readonly string[];
  model?: string;
  /** Reduz a dimensão do vetor (só modelos que suportam). Deve casar com o `vector(N)` do banco. */
  dimensions?: number;
  signal?: AbortSignal;
}

export interface EmbedResult {
  /** Um vetor por texto, NA MESMA ORDEM de `input`. */
  embeddings: number[][];
  dimensions: number;
  usage: TokenUsage;
  costUsd: number | null;
  model: string;
  requestId?: string | undefined;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(request: EmbedRequest): Promise<EmbedResult>;
}
