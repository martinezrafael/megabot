# Fixtures do webhook do WhatsApp (API)

- `official-*.json`: exemplos copiados da documentação da Meta.
- Os demais são modelados a partir da documentação (não são capturas reais).
- `real/`: payloads **reais, já anonimizados**, capturados do seu número de teste.
  O teste `whatsapp-webhook.test.ts` envia cada arquivo daqui ao endpoint, com assinatura válida,
  e exige 200 e eventos gravados.

## Como adicionar um payload real

1. Receba uma mensagem/status no seu número de teste e copie o JSON do log (ou do painel da Meta).
2. Anonimize (troca telefones, nomes, textos, ids de mensagem e de mídia):

   ```bash
   pnpm --filter @megabot/api webhook:anonymize ~/captura.json apps/api/tests/fixtures/whatsapp/real/texto.json
   ```

3. **Abra o arquivo e confira** se não sobrou nenhum dado pessoal antes de commitar.
