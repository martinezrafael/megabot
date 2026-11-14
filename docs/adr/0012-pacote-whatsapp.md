# ADR 0012 — Pacote `@megabot/whatsapp`

- **Status:** Aceita
- **Data:** 2026-11-13
- **Contexto da task:** T1.1

## Contexto

API e worker precisam enviar mensagens e interpretar webhooks da WhatsApp Cloud API. Essa lógica
não pode ficar espalhada nem acoplada ao Nest ou ao banco.

## Decisões

| Tema            | Escolha                                                                                                 | Por quê                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Cliente HTTP    | **Próprio**, sobre o `fetch` nativo do Node 22 (injetável)                                              | Poucos endpoints; sem dependência; testes sem rede                      |
| Retentativas    | **Nenhuma** no pacote; ele informa `retryable`/`category`                                               | O pg-boss (ADR 0005) controla tentativas, espera e idempotência         |
| Webhooks        | **Zod** (tolerante a campos novos) e eventos normalizados (`message`, `status`, `error`)                | A Meta adiciona campos sem aviso; um item ruim não pode derrubar o lote |
| Segurança       | Assinatura `X-Hub-Signature-256` e handshake com comparação em tempo constante                          | Impede webhooks forjados                                                |
| Observabilidade | Logger e métricas **injetados**; `tenant_id` em todo log/métrica; sem token, texto ou telefone completo | Rastreabilidade sem vazar dados de clientes (LGPD)                      |
| Versão da API   | `apiVersion` configurável (padrão `v23.0`)                                                              | A Meta aposenta versões antigas; trocar não exige mudar código          |

## Consequências

- Um `WhatsAppClient` por número/tenant: o token fica por tenant e nunca em variável global.
- A regra da janela de 24h (ADR 0010) **não** vive aqui: o pacote só expõe `timestamp` das mensagens e o
  erro `131047` (`window_expired`). Quem decide enviar ou bloquear é a camada de domínio.
- Métrica com `tenant_id` como rótulo aumenta a cardinalidade; aceitável no MVP, revisar com muitos tenants.
- A tabela de códigos de erro precisa de revisão periódica contra a documentação oficial.
- Payloads reais devem ser adicionados a `packages/whatsapp/tests/fixtures/real/` assim que houver número de teste.
