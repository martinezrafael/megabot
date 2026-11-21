import { ApiProperty } from '@nestjs/swagger';

/** Uma versão da configuração do agente. `version: 0` = ainda não salvaram nada (é o padrão). */
export class AgentConfigDto {
  @ApiProperty({
    type: Number,
    example: 3,
    description: '1, 2, 3... por empresa. 0 significa que ainda não existe versão salva.',
  })
  version!: number;
  @ApiProperty({ type: String, example: 'Bia' })
  name!: string;
  @ApiProperty({ type: String, enum: ['formal', 'neutro', 'amigavel', 'descontraido'] })
  tone!: string;
  @ApiProperty({ type: String, example: 'Oi! Eu sou a Bia, da Loja Modelo. Como posso ajudar?' })
  greeting!: string;
  @ApiProperty({
    type: [String],
    example: ['base_conhecimento'],
    description: 'Chaves das ferramentas habilitadas (catálogo em GET /agent-config/options)',
  })
  tools!: string[];
  @ApiProperty({
    type: [String],
    example: ['Nunca prometa prazo que não está na base.'],
    description: 'Regras de atendimento, na ordem em que a tela mostra',
  })
  rules!: string[];
  @ApiProperty({ type: String, nullable: true, description: 'Quem salvou esta versão' })
  createdByName!: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1,
    description: 'Preenchido quando esta versão nasceu de um "restaurar versão N"',
  })
  restoredFromVersion!: number | null;
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'Nulo quando version = 0 (padrão, nunca salvo)',
  })
  createdAt!: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'true quando esta é a versão que o agente está usando (a de maior número)',
  })
  active!: boolean;
}

export class SaveAgentConfigBodyDto {
  @ApiProperty({ type: String, maxLength: 80, example: 'Bia' })
  name!: string;
  @ApiProperty({ type: String, enum: ['formal', 'neutro', 'amigavel', 'descontraido'] })
  tone!: string;
  @ApiProperty({ type: String, maxLength: 1000, example: 'Oi! Eu sou a Bia, da Loja Modelo.' })
  greeting!: string;
  @ApiProperty({
    type: [String],
    example: ['base_conhecimento'],
    description: 'Só ferramentas com status "disponivel" são aceitas',
  })
  tools!: string[];
  @ApiProperty({
    type: [String],
    maxItems: 30,
    example: ['Nunca prometa prazo que não está na base.'],
    description: 'Itens vazios são descartados',
  })
  rules!: string[];
}

export class AgentConfigVersionPageDto {
  @ApiProperty({ type: Number, description: 'Total de versões já salvas' })
  total!: number;
  @ApiProperty({ type: Number, description: 'Número da versão que está no ar (0 = nenhuma)' })
  activeVersion!: number;
  @ApiProperty({ type: [AgentConfigDto], description: 'Da mais nova para a mais antiga' })
  items!: AgentConfigDto[];
}

export class AgentToneOptionDto {
  @ApiProperty({ type: String, example: 'amigavel' })
  key!: string;
  @ApiProperty({ type: String, example: 'Amigável' })
  label!: string;
  @ApiProperty({ type: String, description: 'Como esse tom soa, em uma frase' })
  hint!: string;
}

export class AgentToolOptionDto {
  @ApiProperty({ type: String, example: 'base_conhecimento' })
  key!: string;
  @ApiProperty({ type: String, example: 'Consultar a base de conhecimento' })
  label!: string;
  @ApiProperty({ type: String })
  description!: string;
  @ApiProperty({
    type: String,
    enum: ['disponivel', 'em_breve'],
    description:
      'disponivel = o agente faz isso hoje; em_breve = está no mapa e NÃO pode ser habilitada',
  })
  status!: string;
}

/** O que a tela precisa para montar o formulário sem repetir rótulos no front. */
export class AgentConfigOptionsDto {
  @ApiProperty({ type: [AgentToneOptionDto] })
  tones!: AgentToneOptionDto[];
  @ApiProperty({ type: [AgentToolOptionDto] })
  tools!: AgentToolOptionDto[];
  @ApiProperty({ type: Number, example: 80 })
  maxNameLength!: number;
  @ApiProperty({ type: Number, example: 1000 })
  maxGreetingLength!: number;
  @ApiProperty({ type: Number, example: 30 })
  maxRules!: number;
  @ApiProperty({ type: Number, example: 500 })
  maxRuleLength!: number;
}
