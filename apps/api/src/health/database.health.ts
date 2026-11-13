import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { prisma } from '@megabot/database';

export const DB_PING = Symbol('DB_PING');
export type DbPing = () => Promise<unknown>;

/** Ping padrão: uma consulta trivial no Postgres. */
export const defaultDbPing: DbPing = () => prisma.$queryRaw`SELECT 1`;

const TIMEOUT_MS = 2000;

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
    @Inject(DB_PING) private readonly ping: DbPing,
  ) {}

  async isHealthy(key: string) {
    const indicator = this.indicators.check(key);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ping(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`timeout após ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
        }),
      ]);
      return indicator.up();
    } catch (error) {
      return indicator.down({
        message: error instanceof Error ? error.message : 'falha ao consultar o banco',
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
