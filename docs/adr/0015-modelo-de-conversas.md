# ADR 0015 — Modelo de conversas (contatos, conversas, mensagens) e janela de 24h

- **Status:** Aceita
- **Data:** 2026-11-17
- **Contexto da task:** T1.4 (implementa o [ADR 0010](0010-janela-de-conversa-24h.md); base da cota do [ADR 0011](0011-regra-de-cota.md))

## Contexto

O webhook (T1.2) guarda eventos brutos e a fila (T1.3) os entrega ao worker. Falta o modelo de domínio:
quem é o contato, o que é uma conversa e onde ficam as mensagens, com a regra da janela de 24h.

## Decisões

| Tema                      | Escolha                                                                                                                                                                                                                                                                | Por quê                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Conversa = janela         | A tabela `conversations` guarda **uma janela de 24h** de um contato (é a `conversa_janela` prevista no ADR 0010, com o nome do produto). Estado guardado: `open` \| `expired`                                                                                          | ADR 0011: cota conta janelas abertas; uma linha por janela dá auditoria e histórico    |
| Uma janela ativa          | Índice único **parcial** `(tenant_id, contact_id) WHERE status = 'open'`                                                                                                                                                                                               | O banco garante a regra mesmo se o código errar ou houver corrida                      |
| Estado efetivo            | Calculado com o relógio: `active` \| `expiring` (última hora) \| `expired`. Uma conversa `open` já vencida conta como `expired` sem esperar a varredura                                                                                                                | O envio nunca depende de um job rodar a tempo                                          |
| Limite exato              | Janela aberta enquanto `agora < vencimento`. No instante exato (24h cravadas) já está fechada                                                                                                                                                                          | Conservador: evita mandar mensagem que a Meta rejeitaria                               |
| Renovação                 | Só mensagem **recebida** renova (vencimento = mensagem + 24h, nunca encurta). Mensagem enviada nunca renova                                                                                                                                                            | ADR 0010, decisão 3                                                                    |
| Idempotência              | `UNIQUE(tenant_id, wamid)`; reentrega devolve o registro existente **sem** abrir/renovar nada. Vale o wamid, mesmo com timestamp diferente                                                                                                                             | ADR 0010, decisão 7                                                                    |
| Fora de ordem             | A hora é a da Meta (`sent_at`). Mensagem mais antiga que a janela recua o início sem encurtar o prazo; mensagem atrasada de janela já expirada é anexada a ela (não reabre, não conta cota); mensagem tão antiga que a janela dela já passou nasce `expired`           | Webhooks da Meta chegam fora de ordem e repetidos                                      |
| Concorrência              | A linha do contato é travada (`INSERT … ON CONFLICT DO UPDATE`) durante a transação: mensagens do mesmo contato entram uma por vez                                                                                                                                     | Sem corrida entre abrir/renovar janela                                                 |
| Status de envio           | `queued → sent → delivered → read`; `failed` só a partir de `queued`/`sent`. O status só avança; evento repetido/fora de ordem é ignorado. Wamid desconhecido → `not_found` (a fila repete)                                                                            | A Meta pode mandar `read` antes de `delivered`, ou o status antes de gravarmos o wamid |
| Envio livre               | `prepareOutboundMessage` checa a janela **na hora do envio** e lança `WindowClosedError` (`retryable: false`, categoria `window_expired`, igual ao 131047 do pacote whatsapp). `kind: 'template'` é permitido sempre; fora de janela fica sem `conversation_id`        | ADR 0010, decisões 5 e 6                                                               |
| Integridade entre tenants | Chaves estrangeiras **compostas** `(tenant_id, id)`: não dá para ligar conversa/mensagem de um tenant a contato de outro                                                                                                                                               | Defesa em profundidade além do RLS                                                     |
| RLS                       | `tenant_isolation_policy` + `FORCE` nas 3 tabelas, como `memberships`                                                                                                                                                                                                  | Padrão do projeto                                                                      |
| Observabilidade           | Logs e métricas opcionais, sempre com `tenant_id`; sem texto, nome ou número completo. Métricas: `conversation_windows_opened_total` (base da cota), `…_renewed_…`, `…_expired_…`, `conversation_messages_total`, `…_outbound_blocked_total`, `…_status_updates_total` | Mesmo padrão do T1.2/T1.3                                                              |

## Consequências

- `windowOpened` (`window: 'opened'` no resultado de `recordInboundMessage`) é o gatilho da cota (ADR 0011): a task da cota reserva o limite
  ao receber `opened`. Hoje **nada é cobrado nem bloqueado**.
- O texto das mensagens (`messages.body`) é dado pessoal: protegido por RLS, **sem política de retenção** ainda (decidir com o ADR de LGPD).
- A varredura `expireDueConversations(tenantId)` existe, mas **nenhum job a agenda** ainda (o estado efetivo cobre a regra; a varredura mantém o banco e os relatórios coerentes).
- O webhook ainda não chama `recordInboundMessage`/`applyStatusUpdate`: a ligação `webhook_events` → conversas é da próxima task (handler de `whatsapp.inbound`).
- O índice parcial só existe no SQL da migration (o Prisma não o declara).
- `contacts` guarda só `wa_id` e nome do perfil; sem opt-out, tags nem atribuição a atendente (fora do escopo).

## Pendente

- Retenção/anonimização de `messages.body` e `contacts.profile_name` (LGPD).
- Janela de 72h de anúncios (ADR 0010, pendente de produto) e conversa iniciada por template.
- Estados de atendimento (bot × humano × encerrada) — produto; hoje só o estado da janela.
