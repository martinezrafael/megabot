import { type DynamicModule, Module } from '@nestjs/common';
import { QueueInspector } from '@megabot/queue';
import type { AppConfig } from '../config';
import { APP_CONFIG } from '../config.tokens';
import { AdminQueuesController } from './admin-queues.controller';
import {
  AdminQueuesService,
  QUEUE_INSPECTOR,
  type QueueInspectorPort,
} from './admin-queues.service';
import { PlatformAdminModule } from './platform-admin.module';

@Module({})
export class AdminModule {
  /** `inspector` só é trocado nos testes. Por padrão lê o Postgres do `DATABASE_URL`. */
  static register(options: { inspector?: QueueInspectorPort } = {}): DynamicModule {
    return {
      module: AdminModule,
      imports: [PlatformAdminModule],
      controllers: [AdminQueuesController],
      providers: [
        AdminQueuesService,
        {
          provide: QUEUE_INSPECTOR,
          inject: [APP_CONFIG],
          useFactory: (config: AppConfig): QueueInspectorPort =>
            options.inspector ?? new QueueInspector({ connectionString: config.databaseUrl }),
        },
      ],
    };
  }
}
