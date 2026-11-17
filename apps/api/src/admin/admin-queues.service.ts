import { Inject, Injectable, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import type { JobSummary, ListJobsOptions, QueuesSnapshot } from '@megabot/queue';
import type { JobSummaryDto, QueuesSnapshotDto } from './admin-queues.dto';

/** O que o serviço precisa do inspetor (facilita trocar por um falso nos testes). */
export interface QueueInspectorPort {
  overview(): Promise<QueuesSnapshot>;
  queueExists(name: string): Promise<boolean>;
  listJobs(options: ListJobsOptions): Promise<JobSummary[]>;
  close(): Promise<void>;
}

export const QUEUE_INSPECTOR = Symbol('QUEUE_INSPECTOR');

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

@Injectable()
export class AdminQueuesService implements OnModuleDestroy {
  constructor(@Inject(QUEUE_INSPECTOR) private readonly inspector: QueueInspectorPort) {}

  async onModuleDestroy(): Promise<void> {
    await this.inspector.close();
  }

  async overview(): Promise<QueuesSnapshotDto> {
    const snapshot = await this.inspector.overview();
    return {
      installed: snapshot.installed,
      generatedAt: snapshot.generatedAt.toISOString(),
      queues: snapshot.queues.map((q) => ({
        ...q,
        lastCompletedAt: iso(q.lastCompletedAt),
        lastFailedAt: iso(q.lastFailedAt),
      })),
    };
  }

  async jobs(options: ListJobsOptions): Promise<JobSummaryDto[]> {
    if (!(await this.inspector.queueExists(options.queue))) {
      throw new NotFoundException(`Fila "${options.queue}" não encontrada`);
    }
    const jobs = await this.inspector.listJobs(options);
    return jobs.map((job) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
      startAfter: job.startAfter.toISOString(),
      startedAt: iso(job.startedAt),
      completedAt: iso(job.completedAt),
    }));
  }
}
