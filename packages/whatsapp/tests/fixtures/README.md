# Fixtures de webhook

- `official-*.json`: copiados **literalmente** dos exemplos da documentação da Meta.
- Os demais seguem as tabelas de campos da documentação (mídia, localização, contatos, botões, status `failed`...).
  **Não são capturas reais.**
- `real/`: coloque aqui payloads capturados do **seu** número de teste (sem dados pessoais).
  O teste `real-payloads.test.ts` roda o parser em todos eles e exige zero itens inválidos.
