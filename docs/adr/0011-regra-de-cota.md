# ADR 0011 — Regra de cota

- **Status:** Proposta (limites numéricos pendentes de decisão do negócio)
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

Cada plano contratado (ADR 0007) deve ter um limite de uso para manter o custo previsível
(LLM, ADR 0009, e mensagens WhatsApp). Precisamos de uma regra **medível, idempotente e justa**,
com comportamento claro ao se aproximar e ao atingir o limite.

## Opções consideradas

| Unidade da cota                          | Prós                                                | Contras                                             |
| ---------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| **Conversas (janelas de 24h, ADR 0010)** | Simples de explicar; alinhada ao modelo do WhatsApp | Uma conversa longa e uma curta contam igual         |
| Mensagens                                | Fácil de contar                                     | Pune conversas naturais com muitas mensagens curtas |
| Tokens do LLM                            | Reflete o custo real                                | Incompreensível para o cliente                      |

## Decisão (proposta)

**Cota por número de conversas por mês, por tenant**, conforme o plano.

1. **Contagem:** +1 quando uma janela é **aberta** (ADR 0010, regra 2). Renovações, mensagens extras e
   respostas do bot não contam. Reentrega de webhook não conta (idempotência pelo id da janela).
2. **Período:** mês de calendário; **fuso `America/Sao_Paulo`**, zera no dia 1º às 00:00. Conversa conta
   no período em que a janela foi **aberta**, mesmo que termine no mês seguinte.
3. **Limite:** `limite_conversas_mes` definido pelo plano (valores abaixo em pendências).
4. **Aviso a 80%:** notificar o tenant (painel + e-mail) uma única vez no período.
5. **Ao atingir 100% (limite):** **novas** conversas não são atendidas pelo bot; o contato recebe uma
   mensagem padrão (se a janela permitir) e o tenant é avisado. Conversas **já abertas** continuam
   até expirar (não se corta atendimento no meio).
6. **Sem franquia automática paga:** o MVP **não** cobra excedente; o tenant faz _upgrade_ de plano
   para liberar mais cota imediatamente.
7. **Inadimplência:** assinatura `inadimplente` segue a carência definida no ADR 0007; vencida a
   carência, a cota efetiva é 0 (nenhuma nova conversa). Dados e painel continuam acessíveis.
8. **Trial:** usa a cota do plano de trial, sem renovação mensal.
9. **Atomicidade:** reservar a cota e abrir a janela na **mesma transação**, para que requisições
   concorrentes não ultrapassem o limite.
10. **Auditoria:** cada conversa contada guarda `periodo`, `janela_id`; o consumo é recalculável.

## Justificativa

Conversa é a unidade que o cliente entende e que acompanha a plataforma do WhatsApp; bloquear só
**novas** conversas protege a experiência de quem já está sendo atendido.

## Consequências

- Tabelas: `plano` (limites) e contador por `(tenant_id, periodo)` com RLS; contador atualizado
  atomicamente (`UPDATE ... WHERE usado < limite RETURNING`).
- Webhook decide "janela nova?" antes de enfileirar para o LLM; sem cota, nem chama o LLM (economiza custo).
- O painel mostra consumo atual, limite e data de renovação.
- Ajuste manual de cota (suporte) deve ser registrado.

## Decisões pendentes

- **Limites por plano** (ex.: quantas conversas/mês em cada plano) — **negócio**.
- Cobrar **excedente** em vez de bloquear? — **negócio**.
- Mensagem padrão ao bloquear novas conversas (texto e se existe transferência para humano) — **produto**.
- Limite adicional de tokens por tenant como proteção de custo? — **time técnico**.
- Fuso do período por tenant, em vez de fixo em São Paulo — adiar até haver clientes fora do Brasil.
