# ADR 0010 — Regra da conversa: janela de 24h por contato

- **Status:** Aceita (a regra base vem da plataforma do WhatsApp; os pontos em "Decisões pendentes" são de produto)
- **Data:** 2026-11-12
- **Contexto da task:** T0.7

## Contexto

O WhatsApp Business Platform só permite mensagens livres dentro de uma **janela de atendimento de
24 horas**. A janela é aberta e renovada **somente por mensagem do cliente**. Fora dela, só é
possível enviar **templates aprovados**, que a Meta cobra por mensagem entregue (modelo vigente
desde 1º/07/2025). A Meta também prevê uma janela de 72h gratuita para contatos vindos de anúncios
_click-to-WhatsApp_ ou botões de página.

Precisamos definir, de forma objetiva, o que é uma "conversa" no MegaBot — base do comportamento
do bot e da cota (ADR 0011).

> Nota: a documentação oficial da Meta não pôde ser acessada nesta sessão; as regras acima vieram de fontes
> secundárias recentes. **Conferir na documentação oficial antes de implementar** e rever este ADR se divergir.
> Preços da Meta mudam por país e por data; não são fixados aqui.

## Decisão

1. **Chave da conversa:** `(tenant_id, contato)`, onde o contato é o número do cliente em formato E.164.
   Um contato tem no máximo **uma janela ativa** por tenant.
2. **Abertura:** a primeira mensagem **recebida** do contato, quando não há janela ativa, abre uma
   janela com `inicio = instante da mensagem` e `expira_em = inicio + 24h`.
3. **Renovação:** cada nova mensagem **recebida** do contato com a janela ativa move `expira_em`
   para `instante da mensagem + 24h` (janela deslizante, como na plataforma). Renovar **não** abre
   nova conversa. Mensagens enviadas pelo bot ou por atendente **não** renovam.
4. **Dentro da janela:** o bot e atendentes podem enviar mensagens livres (texto, mídia, etc.).
5. **Fora da janela (expirada ou inexistente):** envio livre é **bloqueado**. Só é permitido enviar
   um **template aprovado**; no MVP, o bot **não** inicia conversas por template (ver pendências).
   Mensagem do bot que perderia a janela é descartada com registro (`janela_expirada`), nunca enviada.
6. **Verificação no envio:** a checagem de janela acontece **no momento do envio** (no worker, ADR
   0005), não no enfileiramento, pois a janela pode expirar enquanto o job espera.
7. **Idempotência:** o id da mensagem do WhatsApp deduplica reentregas de webhook; uma mensagem
   duplicada não abre nem renova janela duas vezes.
8. **Fuso e relógio:** todos os instantes são armazenados em UTC; a contagem usa o horário do
   servidor/Meta (timestamp da mensagem), nunca o do cliente.
9. **Conversa ≠ ticket:** a "conversa" para cota (ADR 0011) é uma **janela aberta**. Várias
   mensagens e renovações dentro dela contam como **uma** conversa.
10. **Canal de anúncio (72h):** mensagens oriundas de anúncios CTWA podem ter janela gratuita de
    72h na Meta. Fica **fora do MVP**: tratamos como janela comum de 24h.

## Justificativa

Espelhar a regra da plataforma evita enviar mensagens que a Meta rejeitaria e dá uma unidade clara,
auditável e idempotente para medir uso e cobrar (cota).

## Consequências

- Tabela `conversa_janela` (tenant, contato, inicio, expira_em, ultima_mensagem_recebida_em) com
  RLS e índice único parcial garantindo uma janela ativa por `(tenant_id, contato)`.
- Abrir/renovar janela é operação atômica (`INSERT ... ON CONFLICT` ou `UPDATE ... RETURNING`) para
  suportar webhooks concorrentes.
- Camada de envio recusa mensagem livre sem janela ativa: erro de domínio explícito, coberto por testes
  (limite exato de 24h, renovação, duplicata, concorrência).
- Atendente humano vê o tempo restante da janela na interface.

## Decisões pendentes

- O bot poderá **iniciar** conversa por template (reengajamento/avisos)? Muda custo e cota — **produto**.
- Tratar a janela de 72h de anúncios CTWA? — **produto**, quando houver campanhas.
- Mensagem automática ao cliente quando a janela está para expirar (ex.: 1h antes)? — **produto**.
