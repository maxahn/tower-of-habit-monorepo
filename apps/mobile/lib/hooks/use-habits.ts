import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateHabitRequest,
  EntryListResponse,
  HabitDetailResponse,
  HabitListResponse,
  UpdateHabitRequest,
} from '@tower-of-habit/shared';
import { useAuth } from '../auth-context';

export const habitKeys = {
  all: ['habits'] as const,
  list: () => [...habitKeys.all, 'list'] as const,
  detail: (id: string) => [...habitKeys.all, 'detail', id] as const,
  entries: (id: string) => [...habitKeys.all, 'entries', id] as const,
};

export function useHabits() {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: habitKeys.list(),
    queryFn: () => apiClient.apiFetch<HabitListResponse>('/v1/habits'),
  });
}

export function useHabit(id: string) {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: habitKeys.detail(id),
    queryFn: () => apiClient.apiFetch<HabitDetailResponse>(`/v1/habits/${id}`),
    enabled: !!id,
  });
}

export function useHabitEntries(id: string) {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: habitKeys.entries(id),
    queryFn: () => apiClient.apiFetch<EntryListResponse>(`/v1/habits/${id}/entries`),
    enabled: !!id,
  });
}

export function useCreateHabit() {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateHabitRequest) =>
      apiClient.apiFetch<HabitDetailResponse>('/v1/habits', { json: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: habitKeys.list() });
    },
  });
}

export function useUpdateHabit(id: string) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateHabitRequest) =>
      apiClient.apiFetch<HabitDetailResponse>(`/v1/habits/${id}`, {
        method: 'PATCH',
        json: data,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: habitKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: habitKeys.list() });
    },
  });
}

export function useArchiveHabit(id: string) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient.apiFetch<HabitDetailResponse>(`/v1/habits/${id}/archive`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: habitKeys.detail(id) });
      queryClient.invalidateQueries({ queryKey: habitKeys.list() });
    },
  });
}
