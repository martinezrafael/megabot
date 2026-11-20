import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { AiError, defineTool, parseToolCalls, toolToJsonSchema, type ToolCallOf } from '../src';

const buscar = defineTool({
  name: 'buscar_produto',
  description: 'Busca um produto no catálogo',
  parameters: z.object({ termo: z.string().min(2), limite: z.number().int().default(3) }),
});
const transferir = defineTool({
  name: 'transferir_para_humano',
  description: 'Passa a conversa para um atendente',
  parameters: z.object({ motivo: z.string() }),
});
const tools = [buscar, transferir] as const;

describe('ferramentas (tool calling tipado)', () => {
  it('gera o JSON Schema sem a chave $schema', () => {
    const schema = toolToJsonSchema(buscar);
    assert.equal(schema.type, 'object');
    assert.ok(!('$schema' in schema));
    assert.deepEqual(schema.required, ['termo']);
    assert.ok((schema.properties as Record<string, unknown>).termo);
  });

  it('recusa nome de ferramenta inválido', () => {
    assert.throws(
      () => defineTool({ name: 'nome inválido!', description: 'x', parameters: z.object({}) }),
      (e: unknown) => e instanceof AiError && e.category === 'configuration',
    );
  });

  it('valida e tipa os argumentos (com defaults do schema)', () => {
    const calls = parseToolCalls(tools, [
      { id: 'c1', name: 'buscar_produto', arguments: '{"termo":"camiseta"}' },
      { id: 'c2', name: 'transferir_para_humano', arguments: '{"motivo":"cliente pediu"}' },
    ]);
    assert.deepEqual(calls[0], {
      id: 'c1',
      name: 'buscar_produto',
      arguments: { termo: 'camiseta', limite: 3 },
    });
    // Estreitamento por `name`: dentro do if, `arguments` tem o tipo da ferramenta certa.
    for (const call of calls) {
      if (call.name === 'buscar_produto') {
        const limite: number = call.arguments.limite;
        assert.equal(limite, 3);
      } else {
        const motivo: string = call.arguments.motivo;
        assert.equal(motivo, 'cliente pediu');
      }
    }
  });

  it('o tipo é uma união discriminada pelo nome', () => {
    type Call = ToolCallOf<(typeof tools)[number]>;
    const call: Call = { id: '1', name: 'buscar_produto', arguments: { termo: 'x', limite: 1 } };
    // @ts-expect-error argumentos de outra ferramenta
    const wrong: Call = { id: '1', name: 'buscar_produto', arguments: { motivo: 'x' } };
    void call;
    void wrong;
  });

  it('argumentos vazios viram {} (ferramenta sem parâmetros)', () => {
    const noArgs = defineTool({ name: 'ping', description: 'p', parameters: z.object({}) });
    assert.deepEqual(
      parseToolCalls([noArgs], [{ id: '1', name: 'ping', arguments: '' }])[0]?.arguments,
      {},
    );
  });

  it('ferramenta desconhecida, JSON quebrado e argumentos inválidos → invalid_response sem vazar valores', () => {
    const run = (name: string, args: string) => () =>
      parseToolCalls(tools, [{ id: 'c', name, arguments: args }]);
    for (const fn of [
      run('apagar_tudo', '{}'),
      run('buscar_produto', '{quebrado'),
      run('buscar_produto', '{"termo":"a"}'),
      run('buscar_produto', '{"termo":"DADO-SENSIVEL-DO-CLIENTE","limite":"x"}'),
    ]) {
      assert.throws(fn, (e: unknown) => {
        assert.ok(e instanceof AiError);
        assert.equal(e.category, 'invalid_response');
        assert.equal(e.retryable, false);
        assert.ok(!e.message.includes('DADO-SENSIVEL-DO-CLIENTE'));
        return true;
      });
    }
  });
});
