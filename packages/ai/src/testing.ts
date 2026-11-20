import { createHash } from 'node:crypto';
import { AiError } from './errors';
import type {
  EmbedRequest,
  EmbedResult,
  EmbeddingProvider,
  GenerateRequest,
  GenerateResult,
  LLMProvider,
} from './types';
import type { ToolDefinition } from './tools';

/**
 * Dublês para quem USA o pacote (worker, agente) testar sem rede nem custo.
 * Cada resposta roteirizada é consumida na ordem; um `AiError` roteirizado é lançado.
 */
export type ScriptedGenerate = Partial<GenerateResult<readonly ToolDefinition[]>> | AiError;

export class FakeLlmProvider implements LLMProvider {
  readonly name = 'fake';
  readonly calls: Array<GenerateRequest<readonly ToolDefinition[]>> = [];
  private readonly script: ScriptedGenerate[];

  constructor(script: ScriptedGenerate[] = []) {
    this.script = [...script];
  }

  async generate<const T extends readonly ToolDefinition[] = readonly []>(
    request: GenerateRequest<T>,
  ): Promise<GenerateResult<T>> {
    this.calls.push(request as unknown as GenerateRequest<readonly ToolDefinition[]>);
    const next = this.script.shift();
    if (next instanceof AiError) throw next;
    return {
      text: 'resposta de teste',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      model: 'fake',
      ...next,
    } as GenerateResult<T>;
  }
}

/** Vetores determinísticos (mesmo texto → mesmo vetor), normalizados. Servem para testar busca. */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly calls: EmbedRequest[] = [];

  constructor(private readonly dimensions = 8) {}

  async embed(request: EmbedRequest): Promise<EmbedResult> {
    this.calls.push(request);
    const dimensions = request.dimensions ?? this.dimensions;
    const embeddings = request.input.map((text) => {
      const digest = createHash('sha256').update(text).digest();
      const raw = Array.from(
        { length: dimensions },
        (_, i) => digest[i % digest.length]! / 255 - 0.5,
      );
      const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
      return raw.map((v) => v / norm);
    });
    return {
      embeddings,
      dimensions,
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 },
      costUsd: 0,
      model: 'fake',
    };
  }
}
