/**
 * Amostra de base de conhecimento de uma loja (o que um cliente de verdade cadastraria) e as
 * perguntas que esperamos que ela responda. É com isto que medimos relevância.
 */
export interface FonteDeAmostra {
  titulo: string;
  trechos: Array<{ id: string; heading: string | null; texto: string }>;
}

export const CORPUS: FonteDeAmostra[] = [
  {
    titulo: 'Política de trocas e devoluções',
    trechos: [
      {
        id: 'troca-prazo',
        heading: 'Prazo para trocar',
        texto:
          'A troca pode ser solicitada em até 30 dias corridos após o recebimento do produto, desde que a etiqueta esteja intacta e o produto não tenha sido usado.',
      },
      {
        id: 'troca-frete',
        heading: 'Quem paga o frete da troca',
        texto:
          'Na primeira troca o frete é por nossa conta. Em caso de defeito de fabricação, a loja paga o frete de ida e de volta, sempre.',
      },
      {
        id: 'devolucao-dinheiro',
        heading: 'Devolução do dinheiro',
        texto:
          'Para devolução com estorno, o valor volta no mesmo meio de pagamento em até 10 dias úteis após recebermos o produto de volta.',
      },
    ],
  },
  {
    titulo: 'Entrega e frete',
    trechos: [
      {
        id: 'entrega-prazo',
        heading: 'Prazos de entrega',
        texto:
          'Entregamos em todo o Brasil. Capitais recebem em 2 dias úteis; cidades do interior e do Nordeste recebem em até 5 dias úteis.',
      },
      {
        id: 'entrega-frete-gratis',
        heading: 'Frete grátis',
        texto:
          'O frete é grátis para compras acima de 199 reais em qualquer região. Abaixo disso, o valor do frete aparece no carrinho.',
      },
      {
        id: 'entrega-rastreio',
        heading: 'Rastreamento',
        texto:
          'Assim que o pedido é despachado, enviamos o código de rastreio por e-mail e por WhatsApp para acompanhar a entrega.',
      },
    ],
  },
  {
    titulo: 'Formas de pagamento',
    trechos: [
      {
        id: 'pagamento-cartao',
        heading: 'Cartão de crédito',
        texto:
          'Aceitamos cartão de crédito em até 12 vezes sem juros, com parcela mínima de 50 reais. Aceitamos Visa, Mastercard e Elo.',
      },
      {
        id: 'pagamento-pix',
        heading: 'Pix e boleto',
        texto:
          'No Pix o pagamento é aprovado na hora e dá 5 por cento de desconto. O boleto leva até 2 dias úteis para compensar.',
      },
    ],
  },
  {
    titulo: 'Atendimento',
    trechos: [
      {
        id: 'atendimento-horario',
        heading: 'Horário de atendimento',
        texto:
          'Nosso atendimento humano funciona de segunda a sexta, das 9h às 18h, e aos sábados das 9h às 13h. Fora desse horário, o robô responde.',
      },
      {
        id: 'atendimento-loja',
        heading: 'Loja física',
        texto:
          'Temos uma loja física na Rua das Flores, 1234, no bairro Jardim Paulista, em São Paulo. Estacionamento gratuito para clientes.',
      },
    ],
  },
  {
    titulo: 'Catálogo de produtos',
    trechos: [
      {
        id: 'produto-camiseta',
        heading: 'Aba: Produtos',
        texto:
          'SKU: CAM-001 | Nome: Camiseta preta de algodão | Preço: 79,90 | Tamanhos: P, M, G, GG | Estoque: 12 unidades.',
      },
      {
        id: 'produto-calca',
        heading: 'Aba: Produtos',
        texto:
          'SKU: CAL-002 | Nome: Calça jeans azul escura | Preço: 199,50 | Tamanhos: 38 ao 46 | Estoque: esgotado no momento.',
      },
    ],
  },
];

/** Perguntas de clientes e o trecho que deveria ser recuperado para responder. */
export const PERGUNTAS: Array<{ pergunta: string; esperado: string }> = [
  { pergunta: 'Qual o prazo de entrega para o interior do Nordeste?', esperado: 'entrega-prazo' },
  { pergunta: 'A partir de quanto o frete fica grátis?', esperado: 'entrega-frete-gratis' },
  { pergunta: 'Como faço para acompanhar o rastreio do meu pedido?', esperado: 'entrega-rastreio' },
  { pergunta: 'Tenho quantos dias para solicitar a troca do produto?', esperado: 'troca-prazo' },
  {
    pergunta: 'Quem paga o frete quando o produto vem com defeito de fabricação?',
    esperado: 'troca-frete',
  },
  {
    pergunta: 'Em quanto tempo recebo o estorno do dinheiro da devolução?',
    esperado: 'devolucao-dinheiro',
  },
  { pergunta: 'Posso parcelar no cartão de crédito sem juros?', esperado: 'pagamento-cartao' },
  { pergunta: 'Tem desconto pagando no Pix?', esperado: 'pagamento-pix' },
  { pergunta: 'Que horas vocês atendem no sábado?', esperado: 'atendimento-horario' },
  { pergunta: 'Qual o endereço da loja física?', esperado: 'atendimento-loja' },
  { pergunta: 'Quanto custa a camiseta preta de algodão?', esperado: 'produto-camiseta' },
  { pergunta: 'A calça jeans está disponível em estoque?', esperado: 'produto-calca' },
  // Ambíguas de propósito: a palavra-chave aparece em mais de um trecho, e a resposta certa depende
  // do resto da frase. São elas que mostram se a ordenação tem poder de discriminação.
  { pergunta: 'O frete da troca é grátis?', esperado: 'troca-frete' },
  {
    pergunta: 'Quanto tempo demora para o dinheiro voltar para mim?',
    esperado: 'devolucao-dinheiro',
  },
  { pergunta: 'Qual o prazo para o pedido chegar na minha casa?', esperado: 'entrega-prazo' },
];
