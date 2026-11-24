import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeclareAbsenceRequest, DeclareAbsenceResponse } from '@tower-of-habit/shared';
import { useAuth } from '../auth-context';
import { towerKeys } from './use-towers';

export function useDeclareAbsence(towerId: string) {
  const { apiClient } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: DeclareAbsenceRequest) =>
      apiClient.apiFetch<DeclareAbsenceResponse>(`/v1/towers/${towerId}/absence`, { json: data }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: towerKeys.detail(towerId) });
    },
  });
}

export function useCancelAbsence(towerId: string) {
  const { apiClient } = useAuth();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.apiFetch(`/v1/towers/${towerId}/absence`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: towerKeys.detail(towerId) });
    },
  });
}
