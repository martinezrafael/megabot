import { Module } from '@nestjs/common';
import { PlatformAdminModule } from '../admin/platform-admin.module';
import { MeController } from './me.controller';

@Module({ imports: [PlatformAdminModule], controllers: [MeController] })
export class MeModule {}
