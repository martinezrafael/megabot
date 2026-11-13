# ADR 0006 — node:test para testes

- **Status:** Aceita
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

Precisamos de testes unitários e de integração (inclusive contra Postgres real, para validar RLS)
com baixa configuração e execução rápida no CI.

## Opções consideradas

| Opção               | Prós                                                    | Contras                                                    |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| **node:test + tsx** | Embutido no Node; zero dependência de framework; rápido | Menos recursos (snapshots, mocks de módulo mais limitados) |
| Vitest              | Ótima DX, mocks, watch                                  | Dependência extra; sobreposição com o runner nativo        |
| Jest                | Muito conhecido                                         | Pesado, configuração com ESM/TS mais trabalhosa            |

## Decisão

Usar **`node:test`** com `node:assert/strict`, executando TypeScript via **`tsx`**
(`tsx --test`), em cada pacote/app. Testes de integração usam o Postgres do `docker compose`/CI.

## Justificativa

Menos ferramentas para manter e atualizar; o Node já traz _runner_, _mocking_ básico e cobertura.

## Consequências

- Nada de `jest.fn`/`vi.mock`: usar `mock` de `node:test` ou injetar dependências.
- Testes que tocam o banco precisam do serviço no ar (`pnpm db:up`) e do usuário sem `BYPASSRLS`.
- Se a necessidade de recursos avançados crescer, reavaliar com um novo ADR (Vitest é o candidato).
