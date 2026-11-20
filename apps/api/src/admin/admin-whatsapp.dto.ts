import { ApiProperty } from '@nestjs/swagger';

/** Corpo de POST /admin/whatsapp/connections. O token só ENTRA; nenhuma resposta o devolve. */
export class ConnectWhatsappNumberBodyDto {
  @ApiProperty({ type: String, format: 'uuid', description: 'Empresa (tenant) dona do número' })
  tenantId!: string;
  @ApiProperty({
    type: String,
    example: '106540352242922',
    description: '`phone_number_id` da Meta (só dígitos)',
  })
  phoneNumberId!: string;
  @ApiProperty({
    type: String,
    example: '102290129340398',
    description: 'WhatsApp Business Account id',
  })
  wabaId!: string;
  @ApiProperty({
    type: String,
    format: 'password',
    writeOnly: true,
    description:
      'Token de acesso da Cloud API (use um token de usuário de sistema). Guardado cifrado; nunca é devolvido nem logado.',
  })
  accessToken!: string;
  @ApiProperty({ type: String, required: false, example: '+55 11 99999-0000' })
  displayPhoneNumber?: string;
}

export class WhatsappConnectionDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;
  @ApiProperty({ type: String, format: 'uuid' })
  tenantId!: string;
  @ApiProperty({ type: String })
  phoneNumberId!: string;
  @ApiProperty({ type: String })
  wabaId!: string;
  @ApiProperty({ type: String, nullable: true })
  displayPhoneNumber!: string | null;
  @ApiProperty({
    type: Boolean,
    description: 'Há token cifrado guardado (o valor nunca é exibido)',
  })
  hasToken!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Id da chave (KEK) que protege o token',
  })
  tokenKeyId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  tokenUpdatedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: string;
}

export class ConnectWhatsappNumberResponseDto {
  @ApiProperty({
    type: Boolean,
    description: 'true = conexão nova; false = atualizou uma existente',
  })
  created!: boolean;
  @ApiProperty({ type: WhatsappConnectionDto })
  connection!: WhatsappConnectionDto;
}
