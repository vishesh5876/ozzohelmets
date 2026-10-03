import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  type CustomerHelmetDto,
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

/** Explicit on/off switch for the public emergency profile. */
export function EnableProfileCard({
  onEnabled,
}: {
  onEnabled?: (r: EmergencyReadinessDto) => void;
}) {
  const { data: readiness, isLoading } = useReadiness();
  const invalidate = useInvalidateEmergency();
  const enable = useMutation({
    mutationFn: () => api.post<EmergencyReadinessDto>('/customer/emergency-profile/enable'),
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
          <p className="text-display-sm font-bold">
            {readiness.enabled ? 'Emergency profile is on' : 'Emergency profile is off'}
          </p>
          <p className="mt-1 text-body">
            {readiness.enabled
              ? 'Anyone who scans your helmet sees the information you chose to share.'
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
        {readiness.enabled && <HelmetSwitches />}
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
 * With several helmets in use, each one must be switched on explicitly so medical information
 * is never exposed on a helmet by accident (e.g. a spare or a newly received one).
 */
function HelmetSwitches() {
  const qc = useQueryClient();
  const invalidate = useInvalidateEmergency();
  const { data } = useQuery({
    queryKey: keys.helmets,
    queryFn: () => api.get<CustomerHelmetDto[]>('/customer/helmets'),
  });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      api.post(`/customer/helmets/${id}/emergency/${on ? 'enable' : 'disable'}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: keys.helmets });
      await invalidate();
    },
  });
  const inUse = (data ?? []).filter((h) => h.group === 'ACTIVE');
  if (inUse.length < 2) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="helmet-switches">
      <p className="font-medium">Show on which helmets?</p>
      <ul className="flex flex-col divide-y divide-hairline rounded-md border border-hairline">
        {inUse.map((h) => (
          <li key={h.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <span>
              <span className="font-mono font-bold">{h.helmetCode}</span>{' '}
              <span className="text-sm text-body">{h.model.name}</span>
            </span>
            <Button
              size="sm"
              variant={h.emergencyEnabled ? 'secondary' : 'primary'}
              loading={toggle.isPending && toggle.variables?.id === h.id}
              onClick={() => toggle.mutate({ id: h.id, on: !h.emergencyEnabled })}
            >
              {h.emergencyEnabled ? 'Shown · Hide' : 'Hidden · Show'}
            </Button>
          </li>
        ))}
      </ul>
      <InlineError error={toggle.error} />
    </div>
  );
}
