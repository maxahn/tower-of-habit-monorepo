import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTowerRequest,
  HabitDetailResponse,
  TowerDetailResponse,
  TowerListResponse,
} from '@tower-of-habit/shared';
import { useAuth } from '../auth-context';
import { habitKeys } from './use-habits';

export const towerKeys = {
  all: ['towers'] as const,
  list: () => [...towerKeys.all, 'list'] as const,
  detail: (id: string) => [...towerKeys.all, 'detail', id] as const,
};

export function useTowers() {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: towerKeys.list(),
    queryFn: () => apiClient.apiFetch<TowerListResponse>('/v1/towers'),
  });
}

export function useTower(id: string) {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: towerKeys.detail(id),
    queryFn: () => apiClient.apiFetch<TowerDetailResponse>(`/v1/towers/${id}`),
    enabled: !!id,
  });
}

export function useCreateTower() {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTowerRequest) =>
      apiClient.apiFetch<TowerDetailResponse>('/v1/towers', { json: data }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: towerKeys.list() });
      queryClient.invalidateQueries({ queryKey: habitKeys.list() });
    },
  });
}

/**
 * Fetches active habits that aren't already in a tower.
 * Uses the detail endpoint for each habit to check the tower field.
 */
export function useEligibleHabits() {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: ['habits', 'eligible-for-tower'],
    queryFn: async () => {
      const { habits } = await apiClient.apiFetch<{ habits: { id: string; lifecycle: string }[] }>(
        '/v1/habits'
      );
      const active = habits.filter((h) => h.lifecycle === 'active');
      const details = await Promise.all(
        active.map((h) => apiClient.apiFetch<HabitDetailResponse>(`/v1/habits/${h.id}`))
      );
      return details.filter((d) => !d.tower);
    },
  });
}
