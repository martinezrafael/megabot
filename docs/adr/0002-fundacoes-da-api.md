# ADR 0002 — Fundações da API e do web

- **Status:** Aceita
- **Data:** 2026-11-11
- **Contexto da task:** T0.6

## Decisões

| Tema         | Escolha                                                                                                         | Por quê                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Configuração | **Zod**, validada antes de subir (API em `config.ts`, web em `env.ts`)                                          | Falha rápida, com todos os erros listados de uma vez                           |
| Logger       | **pino** via `nestjs-pino`                                                                                      | JSON rápido e estruturado; `request_id`, `tenant_id` e `user_id` em cada linha |
| Erros        | Um **filtro global** com formato único (`ErrorResponseDto`)                                                     | O front trata todos os erros do mesmo jeito; 5xx nunca vaza detalhes           |
| Rate limit   | **`@nestjs/throttler`**, em memória, por IP, com limite mais rígido para `/api/auth/*`                          | Simples e suficiente para uma instância; troca por Redis quando houver várias  |
| Health       | **`@nestjs/terminus`**: `/health` (liveness) e `/health/ready` (banco)                                          | Padrão de orquestradores (Docker, Kubernetes)                                  |
| Contrato     | **OpenAPI** gerado do código (`@nestjs/swagger` + plugin do Better Auth), versionado em `apps/api/openapi.json` | O web gera seus tipos a partir dele; o CI falha se estiver desatualizado       |

## Consequências

- (+) Mudar um controller sem regenerar o contrato quebra o teste e o CI.
- (+) As rotas `/api/auth/*` agora são um controller do Nest, então passam por request id, log, rate limit e filtro de erros.
- (−) O contador do rate limit é por processo. Várias instâncias da API exigem um storage compartilhado.
- (−) O rate limit usa o IP. Atrás de proxy é obrigatório configurar `TRUST_PROXY`; senão todos os usuários parecem ter o mesmo IP.
- (−) O build do web exige `NEXT_PUBLIC_API_URL` (é embutida no bundle).
