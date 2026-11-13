import { ApiProperty } from '@nestjs/swagger';

export class MeUserDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'email', example: 'ana@exemplo.com' })
  email!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: null })
  image!: string | null;

  @ApiProperty({ type: Boolean })
  emailVerified!: boolean;
}

export class MeTenantDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, enum: ['OWNER', 'ADMIN', 'MEMBER'] })
  role!: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export class MeResponseDto {
  @ApiProperty({ type: () => MeUserDto })
  user!: MeUserDto;

  @ApiProperty({
    type: () => MeTenantDto,
    nullable: true,
    description: 'Primeiro (mais antigo) tenant do usuário',
  })
  tenant!: MeTenantDto | null;
}
