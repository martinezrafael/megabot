# ADR 0008 — Hospedagem

- **Status:** Pendente
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

Precisamos hospedar: API (NestJS), worker (pg-boss), web (Next.js) e PostgreSQL 16 com `pgvector`.
Requisitos que já sabemos:

- Containers Docker (existe Dockerfile da API com `HEALTHCHECK`; `/health/ready` disponível).
- PostgreSQL gerenciado com **extensão pgvector**, backups e usuário de aplicação sem `BYPASSRLS`.
- **Latência baixa para o Brasil** (usuários e API do WhatsApp) e atenção à LGPD (dados de clientes brasileiros).
- URL pública estável para os webhooks do WhatsApp e do provedor de cobrança.
- Worker rodando 24/7 (não pode ser _serverless_ que hiberna).
- Custo previsível no MVP.

## Opções consideradas

| Opção                                  | Prós                                                                | Contras                                                                             |
| -------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| PaaS (Railway / Render / Fly.io)       | Deploy simples de containers; Postgres gerenciado; barato para MVP  | Regiões no Brasil variam — **verificar disponibilidade** de São Paulo e de pgvector |
| Cloud grande (AWS / GCP / Azure)       | Região São Paulo, RDS/Cloud SQL com pgvector, escala e conformidade | Mais operação (rede, IAM, IaC) e custo base maior                                   |
| VPS (Hetzner / DigitalOcean / Locaweb) | Preço baixo e controle total                                        | Operação manual: backups, atualização, HA                                           |
| Web na Vercel + API/worker em outro    | Melhor experiência para Next.js                                     | Duas plataformas; CORS/cookies entre domínios; ver `NEXT_PUBLIC_API_URL`            |

> Observação: não foi possível confirmar nesta sessão as regiões e preços atuais de Fly.io/Render
> (documentação fora do acesso). Esses itens devem ser verificados antes da decisão.

## Decisão

**Ainda não tomada.** Recomendação provisória para o MVP: PaaS com containers e Postgres gerenciado
(com pgvector) na região mais próxima do Brasil; migrar para cloud grande se exigências de escala
ou conformidade surgirem. Sem PaaS que atenda aos requisitos, usar AWS em `sa-east-1`.

## Consequências (válidas qualquer que seja a escolha)

- A aplicação segue **12-factor**: config por variáveis de ambiente, logs em stdout (pino), `/health/*` para probes.
- `TRUST_PROXY` e `NEXT_PUBLIC_API_URL` precisam ser definidos no deploy (ADR 0002).
- Rate limit em memória (ADR 0002) assume 1 instância da API; com várias, trocar por _store_ compartilhado.
- Domínios: um para o painel e um para a API/webhooks, ambos com HTTPS.

## Decisões pendentes

- Provedor e região — **responsável: time técnico + negócio** (orçamento).
- Ambientes: apenas `produção` + `local`, ou também `staging`?
- Política de backup/retenção e RPO/RTO desejados.
- Domínio e DNS.
