import type { QueueOverview } from './queues';

/** "42 s", "5 min", "2 h 10 min", "3 d". */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.floor(hours / 24)} d`;
}

export type QueueHealth = 'ok' | 'warning' | 'danger';

/** Espera acima disto (com worker rodando) é sinal de fila parada ou atrasada. */
export const WAITING_WARNING_SECONDS = 5 * 60;

/**
 * Semáforo da fila:
 *  - vermelho: há jobs na DLQ (precisam de atenção humana) ou falhas definitivas;
 *  - amarelo: jobs esperando há mais de 5 min ou aguardando nova tentativa;
 *  - verde: o resto.
 */
export function queueHealth(queue: QueueOverview): QueueHealth {
  if (queue.isDeadLetter) return queue.counts.created > 0 ? 'danger' : 'ok';
  if (queue.counts.failed > 0) return 'danger';
  if (queue.counts.retry > 0) return 'warning';
  if ((queue.oldestWaitingSeconds ?? 0) > WAITING_WARNING_SECONDS) return 'warning';
  return 'ok';
}

export const HEALTH_LABEL: Record<QueueHealth, string> = {
  ok: 'Normal',
  warning: 'Atenção',
  danger: 'Falhas',
};

export const STATE_LABEL: Record<string, string> = {
  created: 'Na fila',
  retry: 'Nova tentativa',
  active: 'Executando',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  failed: 'Falhou',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'medium',
    timeZone: 'America/Sao_Paulo',
  });
}

/** 8 primeiros caracteres do UUID: suficiente para correlacionar com os logs. */
export const shortId = (id: string | null): string => (id ? id.slice(0, 8) : '—');
