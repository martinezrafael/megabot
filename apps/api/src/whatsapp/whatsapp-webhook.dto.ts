import { ApiProperty } from '@nestjs/swagger';

export class WebhookAckDto {
  @ApiProperty({ type: String, example: 'ok' })
  status!: string;
}
