import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

/**
 * Valida com Zod e transforma a falha em 400 com uma lista legível ("campo: motivo; ...").
 * Nunca ecoa o valor recebido (pode ser conteúdo do cliente).
 */
export function parseOrBadRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException(
      result.error.issues
        .map((issue) => `${issue.path.join('.') || 'valor'}: ${issue.message}`)
        .join('; '),
    );
  }
  return result.data;
}
