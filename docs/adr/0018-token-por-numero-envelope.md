# ADR 0018 — Token por número com criptografia de envelope

- **Status:** Aceita
- **Data:** 2026-11-19
- **Contexto da task:** T1.7 (resolve a pendência do [ADR 0017](0017-envio-e-status.md) e o token por tenant do [ADR 0012](0012-pacote-whatsapp.md))

## Contexto

Até a T1.6 o worker usava UM token global (`WHATSAPP_API_TOKEN`) para todos os tenants. Cada empresa tem o seu
número e o seu token; o token dá acesso total à conta da empresa na Meta e não pode ficar em texto puro no
banco, em log, em resposta de API nem em backup legível.

## Decisões

| Tema                 | Escolha                                                                                                                                                                                                      | Por quê                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Onde fica o token    | Em `whatsapp_connections.access_token_envelope` (+ `token_key_id`, `token_updated_at`), **um por número**                                                                                                    | Cada tenant com o seu; o RLS existente já isola as linhas                              |
| Criptografia         | **Envelope**: cada token é cifrado com uma DEK aleatória (AES-256-GCM); a DEK é cifrada com a KEK (AES-256-GCM). Guarda-se `v1.<kekId>.<DEK cifrada>.<iv>.<tag>.<texto cifrado>`                             | Uma chave comprometida/rodada não exige recifrar com a mesma chave tudo; padrão de KMS |
| Amarração (AAD)      | O AAD é `whatsapp-token:<tenantId>:<phoneNumberId>`. Copiar o envelope para a linha de outro tenant/número **falha** na decriptação                                                                          | Evita troca/cópia de segredos entre linhas                                             |
| Onde mora a KEK      | `TOKEN_ENCRYPTION_KEYS="id:base64,..."` (32 bytes cada) no ambiente de **API e worker**; `TOKEN_ENCRYPTION_ACTIVE_KEY_ID` escolhe a ativa. Obrigatória na API em produção. A KEK **nunca** vai ao banco/logs | Sem a KEK o dump do banco é inútil. Simples hoje                                       |
| Pronto para KMS      | A KEK só é tocada pela interface `KeyWrapper` (`wrap`/`unwrap` assíncronos). Trocar `LocalKeyring` por AWS/GCP KMS é implementar a interface; envelopes guardam o id da chave                                | Sem reescrever o resto quando o provedor (ADR 0008) for definido                       |
| Rotação              | Adicionar a chave nova, torná-la ativa; envelopes antigos seguem legíveis (id da chave no envelope). Reconectar o número regrava com a chave ativa. Remover a chave antiga só depois de regravar tudo        | Rotação sem indisponibilidade                                                          |
| Rota de admin        | `POST /admin/whatsapp/connections` (só `PlatformAdminGuard`) e `GET /admin/whatsapp/connections?tenantId=`. O token **entra** no corpo e **nunca** sai (resposta só tem `hasToken`/`tokenKeyId`)             | Antes da tela de conexão (Embedded Signup), um caminho seguro e auditável              |
| Uso no worker        | `whatsapp.outbound` decifra o token do número **na hora do envio**; só o cliente HTTP o vê. Sem token no número, usa o `WHATSAPP_API_TOKEN` global (fallback legado); sem nenhum: falha definitiva           | Não mantém segredo em memória/cache; migração gradual                                  |
| Falha de decriptação | `token_unavailable` (definitiva, mensagem `failed`): repetir não adianta com a chave errada. Erros de banco continuam repetíveis                                                                             | Mesma regra de falha definitiva x transitória do ADR 0017                              |
| Ponte webhook → fila | Um **relay** no worker varre eventos `pending` e enfileira `whatsapp.inbound`/`whatsapp.status` (jobId = id do evento). A API segue sem depender da fila                                                     | Fecha o fluxo (o webhook só gravava); se a fila cair, nada se perde                    |
| Eco                  | `llm.reply` com `WORKER_ECHO_ENABLED=true` responde `Eco: <texto>`; proibido em produção                                                                                                                     | Valida o fluxo ponta a ponta antes do agente real (LLM)                                |
| Observabilidade      | Logs/métricas com `tenant_id` (`whatsapp.connection.admin`, `echo.*`, `inbox_relay.*`, `whatsapp_connection_admin_total`, `echo_replies_total`). Nunca token, envelope, KEK nem texto do cliente             | DoD da T1.7                                                                            |

## Consequências

- **Bom:** token nunca em texto puro; dump do banco sozinho não revela tokens; rotação e KMS sem reescrever.
- **Ruim/atenção:** perder a KEK = perder os tokens (reconectar os números). API e worker precisam das mesmas chaves.
  Um atacante com acesso ao banco **e** ao ambiente da aplicação ainda lê os tokens (limite de qualquer chave em env; KMS reduz isso).
- **Ainda pendente:** KMS gerenciado; tela de conexão (Embedded Signup); `llm.reply` real (LLM); verificar assinatura/idempotência na Meta.
