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

export function useTower(id: string, options?: { refetchInterval?: number }) {
  const { apiClient } = useAuth();
  return useQuery({
    queryKey: towerKeys.detail(id),
    queryFn: () => apiClient.apiFetch<TowerDetailResponse>(`/v1/towers/${id}`),
    enabled: !!id,
    refetchInterval: options?.refetchInterval,
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

export function useRemoveMember(towerId: string) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) =>
      apiClient.apiFetch(`/v1/towers/${towerId}/memberships/${membershipId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: towerKeys.detail(towerId) });
    },
  });
}

export function useLeaveTower(towerId: string) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (membershipId: string) =>
      apiClient.apiFetch(`/v1/towers/${towerId}/memberships/${membershipId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: towerKeys.list() });
      queryClient.invalidateQueries({ queryKey: towerKeys.detail(towerId) });
      queryClient.invalidateQueries({ queryKey: habitKeys.list() });
    },
  });
}

export function useStartTower(towerId: string) {
  const { apiClient } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiClient.apiFetch<TowerDetailResponse>(`/v1/towers/${towerId}/start`, {
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: towerKeys.detail(towerId) });
      queryClient.invalidateQueries({ queryKey: towerKeys.list() });
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
