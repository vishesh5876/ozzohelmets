import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  type CustomerSafetyIdDto,
  type EmergencyReadinessDto,
  ReadinessRequirement,
} from '@helmet/types';
import { Button, Card, CardContent } from '@helmet/ui';
import { InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useInvalidateEmergency, useReadiness } from './hooks';

const MISSING: Record<ReadinessRequirement, { label: string; to: string }> = {
  [ReadinessRequirement.NAME]: { label: 'Add your name', to: '/app/profile' },
  [ReadinessRequirement.EMERGENCY_CONTACT]: {
    label: 'Add at least one emergency contact',
    to: '/app/contacts',
  },
  [ReadinessRequirement.PRIVACY_REVIEW]: { label: 'Review what is public', to: '/app/privacy' },
};

/**
 * Explicit on/off switch for the public emergency profile. `safetyIds` switches sharing on for
 * those Safety IDs too (onboarding after activating one); otherwise the API switches on the only
 * Safety ID in use, and with several the customer chooses each one below.
 */
export function EnableProfileCard({
  onEnabled,
  safetyIds,
}: {
  onEnabled?: (r: EmergencyReadinessDto) => void;
  safetyIds?: string[];
}) {
  const { data: readiness, isLoading } = useReadiness();
  const invalidate = useInvalidateEmergency();
  const enable = useMutation({
    mutationFn: () =>
      api.post<EmergencyReadinessDto>(
        '/customer/emergency-profile/enable',
        safetyIds?.length ? { safetyIds } : undefined,
      ),
    onSuccess: async (r) => {
      await invalidate();
      onEnabled?.(r);
    },
  });
  const disable = useMutation({
    mutationFn: () => api.post<EmergencyReadinessDto>('/customer/emergency-profile/disable'),
    onSuccess: () => invalidate(),
  });

  if (isLoading || !readiness) return <LoadingState />;

  return (
    <Card className={readiness.enabled ? 'border-ink' : ''}>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-display-sm font-semibold">
            {readiness.enabled ? 'Emergency profile is on' : 'Emergency profile is off'}
          </p>
          <p className="mt-1 text-body">
            {readiness.enabled
              ? 'Anyone who scans a Safety ID with sharing on sees the information you chose to share.'
              : 'Turn it on so first responders can see the information you chose to share.'}
          </p>
        </div>
        {!readiness.enabled && readiness.missing.length > 0 && (
          <ul className="flex flex-col gap-2">
            {readiness.missing.map((m) => (
              <li key={m}>
                <Link
                  to={MISSING[m].to}
                  className="flex items-center justify-between rounded-md bg-canvas-soft px-4 py-3 font-medium hover:bg-surface-pressed"
                >
                  {MISSING[m].label} <span aria-hidden>→</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {readiness.enabled && <SafetyIdSwitches />}
        <InlineError error={enable.error ?? disable.error} />
        {readiness.enabled ? (
          <Button variant="secondary" loading={disable.isPending} onClick={() => disable.mutate()}>
            Turn off emergency profile
          </Button>
        ) : (
          <Button
            size="lg"
            disabled={!readiness.canEnable}
            loading={enable.isPending}
            onClick={() => enable.mutate()}
          >
            Turn on emergency profile
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * With several Safety IDs in use, each one must be switched on explicitly so medical information
 * is never exposed on a QR by accident (e.g. a spare sticker or a newly received helmet).
 */
function SafetyIdSwitches() {
  const qc = useQueryClient();
  const invalidate = useInvalidateEmergency();
  const { data } = useQuery({
    queryKey: keys.safetyIds,
    queryFn: () => api.get<CustomerSafetyIdDto[]>('/customer/safety-ids'),
  });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api.post(`/customer/safety-ids/${id}/emergency/${on ? 'enable' : 'disable'}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.safetyIds });
      await qc.invalidateQueries({ queryKey: keys.helmets });
      await invalidate();
    },
  });
  const inUse = (data ?? []).filter(
    (s) =>
      (s.status === 'ACTIVATED' || s.status === 'ACTIVE') &&
      (!s.linkedHelmet || ['ACTIVATED', 'ACTIVE'].includes(s.linkedHelmet.status)),
  );
  if (inUse.length < 2) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="safety-id-switches">
      <p className="font-medium">Show on which Safety IDs?</p>
      <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
        {inUse.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span>
              <span className="font-mono font-bold">{s.safetyCode}</span>{' '}
              <span className="text-sm text-body">
                {s.linkedHelmet ? s.linkedHelmet.modelName : 'Standalone'}
              </span>
            </span>
            <Button
              size="sm"
              variant={s.emergencySharing ? 'secondary' : 'primary'}
              loading={toggle.isPending && toggle.variables?.id === s.id}
              onClick={() => toggle.mutate({ id: s.id, on: !s.emergencySharing })}
            >
              {s.emergencySharing ? 'Shown · Hide' : 'Hidden · Show'}
            </Button>
          </li>
        ))}
      </ul>
      <InlineError error={toggle.error} />
    </div>
  );
}
