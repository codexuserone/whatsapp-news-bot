import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type ReadyStatus = {
  ok?: boolean;
  db?: boolean;
  whatsapp?: string | null;
  dbState?: {
    circuitOpen?: boolean;
    retryAfterMs?: number | null;
    lastFailureMessage?: string | null;
  } | null;
};

export const isDatabaseUnavailable = (ready?: ReadyStatus | null) =>
  ready?.db === false || ready?.dbState?.circuitOpen === true;

export const getDatabaseUnavailableMessage = (ready?: ReadyStatus | null) => {
  const raw = String(ready?.dbState?.lastFailureMessage || '').trim();
  return raw
    ? `Database is unavailable: ${raw}. Sending, queue edits, schedules, feeds, and history are paused until it recovers.`
    : 'Database is unavailable. Sending, queue edits, schedules, feeds, and history are paused until it recovers.';
};

export const useRuntimeStatus = () => {
  const readyQuery = useQuery<ReadyStatus>({
    queryKey: ['ready-status'],
    queryFn: () => api.get('/ready'),
    refetchInterval: 60000
  });

  const databaseUnavailable = isDatabaseUnavailable(readyQuery.data);

  return {
    ready: readyQuery.data,
    readyQuery,
    databaseUnavailable,
    databaseUnavailableMessage: databaseUnavailable ? getDatabaseUnavailableMessage(readyQuery.data) : null
  };
};
