# ADR 0013 — Webhook de entrada do WhatsApp

- **Status:** Aceita
- **Data:** 2026-11-15
- **Contexto da task:** T1.2

## Contexto

A Meta avisa por webhook cada mensagem recebida e cada mudança de status de envio. Ela reenvia o
mesmo aviso se não receber 200, pode entregar eventos fora de ordem e identifica a empresa só pelo
`phone_number_id`. O endpoint precisa recusar chamadas falsas, não duplicar eventos, descobrir o
tenant e responder rápido.

## Decisões

| Tema              | Escolha                                                                                                                                     | Por quê                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Autenticidade     | `X-Hub-Signature-256` (HMAC-SHA256 do **corpo cru** com o app secret), conferido antes de qualquer outro passo                              | Qualquer um pode chamar a URL; só a Meta conhece o segredo                                      |
| Corpo cru         | O bootstrap usa `express.raw` (3 MB) só em `/webhooks/whatsapp`                                                                             | Reformatar o JSON mudaria os bytes e invalidaria a assinatura                                   |
| Verificação (GET) | Devolve `hub.challenge` em texto puro se `hub.verify_token` confere (comparação em tempo constante)                                         | Handshake exigido pela Meta                                                                     |
| Tenant            | Tabela `whatsapp_connections` (número único no sistema) + policy de leitura por `app.phone_number_id`                                       | Mesmo padrão do login (`app.user_id`): o RLS continua valendo; só se lê UMA linha por vez       |
| Idempotência      | `webhook_events` com `UNIQUE (tenant_id, event_key)` e `ON CONFLICT DO NOTHING`                                                             | O banco decide, então reenvios simultâneos também não duplicam                                  |
| Chave do evento   | `message:<wamid>`, `status:<wamid>:<status>`, `error:<uuid>`                                                                                | O mesmo wamid recebe sent/delivered/read: o status precisa entrar na chave                      |
| Fora de ordem     | Guardamos `event_at` (hora da Meta) e `received_at` (chegada); nada é descartado por chegar "tarde"                                         | Quem consome decide pela hora real; o ingresso não depende da ordem                             |
| Caixa de entrada  | Eventos entram como `pending`; o worker os processa depois (`processed`/`failed`)                                                           | Responder 200 rápido: o webhook só valida, grava e responde                                     |
| Respostas         | 200 gravado ou duplicado, **200 também para número sem tenant**; 401 assinatura; 400 payload inválido; 503 sem segredo; 500 falha ao gravar | Erro faz a Meta reenviar por dias: só devolvemos erro quando reenviar pode ajudar (falha nossa) |
| Rate limit        | Rota fora do limite por IP (`@SkipThrottle`)                                                                                                | Rajadas legítimas da Meta; a assinatura e o limite de 3 MB protegem                             |
| Métricas          | Linhas de log `event: "metric"` com `tenant_id`, atrás da interface `WhatsAppMetrics`                                                       | Ainda não há coletor (Prometheus/OTel); trocar o adaptador não mexe no resto                    |

## Consequências

- **Dados pessoais:** `webhook_events.payload` guarda o evento normalizado (texto, telefone, nome). Os logs
  **nunca** os registram. Falta definir **retenção** e anonimização (LGPD) em uma task futura.
- Número sem tenant: o evento é **descartado** (só log e métrica `unknown_number`). Se for desejado
  reprocessar depois que o número for cadastrado, será preciso guardar esses eventos (decisão pendente).
- Rate limit em memória e métricas em log valem para uma instância (ADR 0002, 0008).
- Erro de sistema (`value.errors`) não tem id: reenvios geram linhas repetidas (aceitável, são raros).
- O worker (próxima task) deve ler `pending` por tenant, ordenar por `event_at` e ser idempotente.
- Um número pertence a **um** tenant. Mover um número entre tenants exige apagar e recriar a conexão.

## Decisões pendentes

- Retenção e anonimização dos eventos (LGPD) — **produto/jurídico**.
- Guardar eventos de números ainda não cadastrados? — **produto**.
- Como o tenant liga o número na interface (Embedded Signup da Meta ou cadastro manual) — **produto**.
