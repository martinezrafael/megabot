# ADR 0007 — Cobrança

- **Status:** Proposta (aguarda confirmação do responsável pelo negócio)
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

O MegaBot será vendido por assinatura mensal a empresas brasileiras. Precisamos cobrar de forma
recorrente, receber **Pix** e **boleto** (comuns no B2B brasileiro), além de cartão, e reagir a
pagamento/atraso/cancelamento por **webhook** para ajustar o plano e a cota (ADR 0011).

## Opções consideradas

| Opção                          | Prós                                                                                                       | Contras                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Asaas — Assinaturas**        | Pix, boleto e cartão; cobrança recorrente automática (cartão); webhooks; foco no Brasil; emite NF opcional | Cobrança por boleto/Pix gera fatura que o cliente precisa pagar (sem débito automático) |
| Asaas — Pix Automático         | Débito recorrente autorizado no Pix, menos atrito                                                          | Só Pix; depende de o banco do cliente suportar; adoção ainda crescendo                  |
| Stripe                         | API excelente, boa documentação, cartão recorrente robusto                                                 | Pix/boleto com recorrência menos naturais; menos adequado ao fluxo fiscal brasileiro    |
| Mercado Pago / Pagar.me / Iugu | Opções locais                                                                                              | Não avaliadas em profundidade                                                           |

## Decisão (proposta)

Usar **Asaas — Assinaturas** como provedor inicial, por trás de uma interface interna
`BillingProvider` (criar cliente, criar assinatura, cancelar, consultar). Pix Automático fica como
evolução. Eventos chegam por **webhook** com validação de token e **idempotência** por id do evento,
processados via pg-boss (ADR 0005).

## Justificativa

Atende o meio de pagamento predominante no Brasil sem exigir cartão, e a interface isolada evita
acoplar o domínio ao fornecedor.

## Consequências

- Nova tabela de assinatura/fatura por tenant e estados: `trial`, `ativa`, `inadimplente`, `cancelada`.
- Segredos (`ASAAS_API_KEY`, token de webhook) entram no `.env.example` e na validação de ambiente.
- Ambiente _sandbox_ do Asaas para testes; webhook precisa de URL pública (ver `WEBHOOK_BASE_URL`).
- Conformidade: não armazenamos dados de cartão (o Asaas é o PCI).

## Decisões pendentes

- Confirmar o provedor (Asaas vs. Stripe) — **responsável: negócio**.
- Planos, preços e período de _trial_.
- Política de inadimplência (carência antes de bloquear; ver ADR 0011).
- Emissão de nota fiscal: necessária no MVP?
- Taxas e condições comerciais atuais devem ser conferidas direto no Asaas antes de fechar (não validadas aqui).
