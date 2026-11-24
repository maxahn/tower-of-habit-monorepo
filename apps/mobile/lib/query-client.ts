import { QueryClient } from '@tanstack/react-query';
import { NetworkError } from './api-client';

function isNetworkError(error: unknown): boolean {
  return error instanceof NetworkError;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        retry: 2,
        networkMode: 'offlineFirst',
      },
      mutations: {
        networkMode: 'offlineFirst',
        retry: (failureCount, error) => {
          if (isNetworkError(error) && failureCount < 3) return true;
          return false;
        },
        retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
      },
    },
  });
}
