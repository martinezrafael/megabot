import { z } from 'zod';
import { AiError } from './errors';

/**
 * Ferramenta (tool/function) que o modelo pode chamar. `parameters` é um schema Zod: dele sai o JSON
 * Schema enviado ao provedor E a validação (com tipos) dos argumentos que o modelo devolve.
 */
export interface ToolDefinition<
  TName extends string = string,
  TParams extends z.ZodObject = z.ZodObject,
> {
  readonly name: TName;
  readonly description: string;
  readonly parameters: TParams;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Declara uma ferramenta. O nome vira tipo literal: é o que torna `toolCalls` tipado. */
export function defineTool<const TName extends string, TParams extends z.ZodObject>(definition: {
  name: TName;
  description: string;
  parameters: TParams;
}): ToolDefinition<TName, TParams> {
  if (!TOOL_NAME.test(definition.name)) {
    throw new AiError(
      `Nome de ferramenta inválido: "${definition.name}" (use letras, números, _ e -).`,
      {
        category: 'configuration',
        retryable: false,
      },
    );
  }
  return definition;
}

/** Chamada de ferramenta devolvida pelo modelo, já validada: `arguments` tem o tipo do schema. */
export type ToolCallOf<T extends ToolDefinition> =
  T extends ToolDefinition<infer N, infer P>
    ? { id: string; name: N; arguments: z.output<P> }
    : never;

/** Formato enviado ao provedor (JSON Schema, sem a chave `$schema`). */
export function toolToJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.parameters, { target: 'draft-7', io: 'input' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return schema;
}

/**
 * Valida as chamadas brutas do modelo contra as ferramentas declaradas.
 * Ferramenta desconhecida, JSON quebrado ou argumentos fora do schema → `AiError('invalid_response')`.
 * A mensagem lista só caminhos/regras (nunca os valores: podem conter dados do cliente).
 */
export function parseToolCalls<const T extends readonly ToolDefinition[]>(
  tools: T,
  rawCalls: ReadonlyArray<{ id: string; name: string; arguments: string }>,
): Array<ToolCallOf<T[number]>> {
  return rawCalls.map((call) => {
    const tool = tools.find((t) => t.name === call.name);
    if (!tool) {
      throw new AiError(`O modelo chamou uma ferramenta não declarada: "${call.name}".`, {
        category: 'invalid_response',
        retryable: false,
      });
    }
    let json: unknown;
    try {
      json = call.arguments.trim() ? JSON.parse(call.arguments) : {};
    } catch {
      throw new AiError(`Argumentos da ferramenta "${call.name}" não são um JSON válido.`, {
        category: 'invalid_response',
        retryable: false,
      });
    }
    const parsed = tool.parameters.safeParse(json);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'valor'}: ${i.message}`)
        .join('; ');
      throw new AiError(`Argumentos inválidos para a ferramenta "${call.name}": ${problems}`, {
        category: 'invalid_response',
        retryable: false,
      });
    }
    return { id: call.id, name: call.name, arguments: parsed.data } as ToolCallOf<T[number]>;
  });
}
