import { QueryClient } from '@tanstack/react-query';

const getErrorStatus = (error: unknown) => {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  return Number.isFinite(status) ? status : null;
};

const shouldRetry = (failureCount: number, error: unknown) => {
  const status = getErrorStatus(error);
  if (status === 401 || status === 403 || status === 429) return false;
  if (status !== null && status >= 400 && status < 500) return false;
  return failureCount < 1;
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: shouldRetry
    },
    mutations: {
      retry: false
    }
  }
});
