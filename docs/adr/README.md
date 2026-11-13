# Registro de decisões (ADRs)

Cada decisão técnica ou de negócio relevante do MegaBot vira um ADR (_Architecture Decision Record_):
um arquivo curto, versionado junto com o código, que explica **o que** foi decidido e **por quê**.

## Índice

| Nº                                     | Decisão                                       | Status   |
| -------------------------------------- | --------------------------------------------- | -------- |
| [0001](0001-autenticacao.md)           | Provedor de autenticação (Better Auth)        | Aceita   |
| [0002](0002-fundacoes-da-api.md)       | Fundações da API (Zod, pino, throttler, ...)  | Aceita   |
| [0003](0003-nestjs-com-typescript.md)  | NestJS com TypeScript                         | Aceita   |
| [0004](0004-prisma-e-postgresql.md)    | Prisma + PostgreSQL com RLS                   | Aceita   |
| [0005](0005-pg-boss-para-filas.md)     | pg-boss para filas e jobs                     | Aceita   |
| [0006](0006-node-test-para-testes.md)  | node:test para testes                         | Aceita   |
| [0007](0007-cobranca.md)               | Cobrança (Asaas)                              | Proposta |
| [0008](0008-hospedagem.md)             | Hospedagem                                    | Pendente |
| [0009](0009-provedor-de-llm.md)        | Provedor de LLM                               | Proposta |
| [0010](0010-janela-de-conversa-24h.md) | Regra da conversa (janela de 24h por contato) | Aceita   |
| [0011](0011-regra-de-cota.md)          | Regra de cota                                 | Proposta |

## Status

- **Aceita** — decidido e em uso (ou pronto para uso). Só muda por um novo ADR.
- **Proposta** — há uma recomendação, mas falta confirmação de quem decide.
- **Pendente** — faltam informações ou escolha; as opções estão documentadas.
- **Substituída** — trocada por outro ADR (indicar qual).

## Como criar um novo ADR

1. Copie o modelo abaixo para `docs/adr/NNNN-titulo-curto.md` (próximo número livre).
2. Preencha, abra PR e adicione a linha no índice acima.
3. Nunca reescreva uma decisão aceita: crie um novo ADR que a substitua e marque o antigo como _Substituída_.

## Modelo

```md
# ADR NNNN — Título

- **Status:** Proposta | Aceita | Pendente | Substituída por NNNN
- **Data:** AAAA-MM-DD
- **Contexto da task:** Tx.y

## Contexto

Qual problema estamos resolvendo e quais restrições existem.

## Opções consideradas

| Opção | Prós | Contras |
| ----- | ---- | ------- |

## Decisão

O que foi escolhido, de forma objetiva.

## Justificativa

Por que esta opção venceu as outras.

## Consequências

Efeitos técnicos (bons e ruins) e o que muda no dia a dia.

## Decisões pendentes

O que ainda precisa ser definido, por quem.
```
