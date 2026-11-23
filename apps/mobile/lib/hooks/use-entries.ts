import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  EntryListResponse,
  EntryResponse,
  LogEntryRequest,
  LogEntryResponse,
} from '@tower-of-habit/shared';
import { useAuth } from '../auth-context';
import { habitKeys } from './use-habits';

export function useLogEntry(habitId: string, towerId?: string | null) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: LogEntryRequest) =>
      apiClient.apiFetch<LogEntryResponse>('/v1/entries', { json: data }),
    onMutate: async (data) => {
      await queryClient.cancelQueries({ queryKey: habitKeys.entries(habitId) });
      const previous = queryClient.getQueryData<EntryListResponse>(habitKeys.entries(habitId));

      const optimisticEntry: EntryResponse = {
        id: data.clientEntryId ?? crypto.randomUUID(),
        habitId,
        localDate: data.localDate ?? new Date().toISOString().slice(0, 10),
        tierReached: data.tierReached ?? 0,
        numericValue: data.numericValue ?? null,
        loggedAt: new Date().toISOString(),
        countsTowardQuota: true,
        clientEntryId: data.clientEntryId ?? null,
        createdAt: new Date().toISOString(),
      };

      queryClient.setQueryData<EntryListResponse>(habitKeys.entries(habitId), (old) => ({
        entries: [optimisticEntry, ...(old?.entries ?? [])],
      }));

      return { previous };
    },
    onError: (_err, _data, context) => {
      if (context?.previous) {
        queryClient.setQueryData(habitKeys.entries(habitId), context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: habitKeys.entries(habitId) });
      queryClient.invalidateQueries({ queryKey: habitKeys.detail(habitId) });
      if (towerId) {
        queryClient.invalidateQueries({ queryKey: ['towers', 'detail', towerId] });
      }
    },
  });
}
