import { type DynamicModule, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseHealthIndicator, DB_PING, type DbPing, defaultDbPing } from './database.health';
import { HealthController } from './health.controller';

@Module({})
export class HealthModule {
  /** `ping` só é trocado nos testes (para simular o banco fora do ar). */
  static register(options: { ping?: DbPing } = {}): DynamicModule {
    return {
      module: HealthModule,
      imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
      controllers: [HealthController],
      providers: [
        DatabaseHealthIndicator,
        { provide: DB_PING, useValue: options.ping ?? defaultDbPing },
      ],
    };
  }
}
