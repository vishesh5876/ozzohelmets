import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EmergencyContactDto,
  EmergencyProfileDto,
  EmergencyReadinessDto,
  EmergencyVisibilityDto,
  PublicEmergencyDto,
} from '@helmet/types';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';

export const useProfile = () =>
  useQuery({
    queryKey: keys.profile,
    queryFn: () => api.get<EmergencyProfileDto>('/customer/emergency-profile'),
  });
export const useContacts = () =>
  useQuery({
    queryKey: keys.contacts,
    queryFn: () => api.get<EmergencyContactDto[]>('/customer/emergency-contacts'),
  });
export const useVisibility = () =>
  useQuery({
    queryKey: keys.visibility,
    queryFn: () => api.get<EmergencyVisibilityDto>('/customer/emergency-visibility'),
  });
export const useReadiness = () =>
  useQuery({
    queryKey: keys.readiness,
    queryFn: () => api.get<EmergencyReadinessDto>('/customer/emergency-profile/readiness'),
  });
export const usePreview = () =>
  useQuery({
    queryKey: keys.preview,
    queryFn: () =>
      api.get<Pick<PublicEmergencyDto, 'profile' | 'contacts'>>(
        '/customer/emergency-profile/preview',
      ),
  });

/** After any emergency mutation: refresh profile data, readiness, helmet statuses and dashboard. */
export function useInvalidateEmergency() {
  const qc = useQueryClient();
  return () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['emergency'] }),
      qc.invalidateQueries({ queryKey: ['helmets'] }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
}
