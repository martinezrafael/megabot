# ADR 0003 — NestJS com TypeScript

- **Status:** Aceita
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

A API precisa receber webhooks do WhatsApp, expor endpoints para o painel, rodar autenticação,
isolamento por tenant e integrações (cobrança, LLM). Vários módulos vão crescer em paralelo, então
precisamos de uma estrutura que force organização e injeção de dependências.

## Opções consideradas

| Opção                   | Prós                                                                          | Contras                                               |
| ----------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| **NestJS + TypeScript** | Módulos, DI, guards/pipes/filters; ecossistema (Swagger, Terminus, Throttler) | Mais cerimônia (decorators); curva de aprendizado     |
| Fastify/Express "puro"  | Leve, poucas abstrações                                                       | Cada pessoa organiza de um jeito; DI e padrões à mão  |
| Hono / Elysia           | Muito rápido e enxuto                                                         | Ecossistema menor para o que precisamos (OpenAPI, DI) |

## Decisão

Usar **NestJS 11 (adaptador Express 5) com TypeScript** em `apps/api`, compilado com **SWC**.
Contrato validado com **Zod** (ADR 0002) e documentado com OpenAPI.

## Justificativa

- Estrutura padronizada reduz divergência entre módulos e facilita revisão.
- Guards, interceptors e filters encaixam direto em multitenancy, autenticação e logs.
- TypeScript no monorepo inteiro permite compartilhar tipos (`packages/*`) entre API e web.

## Consequências

- Decorators exigem `experimentalDecorators`/`emitDecoratorMetadata`; por isso o build usa SWC com config dedicada.
- O worker (pg-boss, ADR 0005) pode reutilizar módulos Nest como _standalone application_.
- Trocar de framework no futuro seria caro; a regra de negócio deve ficar em serviços sem dependência de HTTP.
