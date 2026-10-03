import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { EmergencyVisibilityDto, EmergencyVisibilityInput } from '@helmet/types';
import { Button } from '@helmet/ui';
import { InlineError, LoadingState, SavedNote } from '../../components/States';
import { api } from '../../lib/api';
import { useInvalidateEmergency, useVisibility } from './hooks';

const OPTIONS: {
  key: keyof EmergencyVisibilityInput;
  label: string;
  hint: string;
  sensitive?: boolean;
}[] = [
  { key: 'showName', label: 'Name', hint: 'Helps responders address you and identify you.' },
  {
    key: 'showEmergencyContacts',
    label: 'Emergency contacts',
    hint: 'Lets anyone helping you call your contacts.',
  },
  { key: 'showBloodGroup', label: 'Blood group', hint: 'Useful in trauma care.' },
  {
    key: 'showAllergies',
    label: 'Allergies',
    hint: 'Can prevent dangerous reactions.',
    sensitive: true,
  },
  {
    key: 'showMedicalConditions',
    label: 'Medical conditions',
    hint: 'e.g. diabetes, epilepsy, heart conditions.',
    sensitive: true,
  },
  {
    key: 'showMedications',
    label: 'Medications',
    hint: 'What you take regularly.',
    sensitive: true,
  },
  {
    key: 'showEmergencyNotes',
    label: 'Emergency notes',
    hint: 'Your free-text notes.',
    sensitive: true,
  },
  { key: 'showPhoto', label: 'Photo', hint: 'Helps confirm the right person.' },
  {
    key: 'showDateOfBirth',
    label: 'Date of birth & age',
    hint: 'Age helps with dosing decisions.',
    sensitive: true,
  },
  { key: 'showGender', label: 'Gender', hint: '' },
  { key: 'showOrganDonor', label: 'Organ donor status', hint: '' },
];

const toInput = (v: EmergencyVisibilityDto): EmergencyVisibilityInput =>
  Object.fromEntries(OPTIONS.map((o) => [o.key, v[o.key]])) as EmergencyVisibilityInput;

/**
 * Explicit choice of what anyone scanning the helmet can see. Everything starts hidden;
 * saving is the privacy review required before the profile can be enabled.
 */
export function VisibilityForm({
  onSaved,
  submitLabel = 'Save privacy choices',
}: {
  onSaved?: () => void;
  submitLabel?: string;
}) {
  const { data, isLoading } = useVisibility();
  const invalidate = useInvalidateEmergency();
  const [values, setValues] = useState<EmergencyVisibilityInput | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data) setValues(toInput(data));
  }, [data]);

  const save = useMutation({
    mutationFn: (v: EmergencyVisibilityInput) =>
      api.put<EmergencyVisibilityDto>('/customer/emergency-visibility', v),
    onSuccess: async () => {
      await invalidate();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    },
  });

  if (isLoading || !values || !data) return <LoadingState />;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(values);
      }}
    >
      <p className="text-body">
        Choose what anyone who scans your helmet can see. Nothing is public unless you switch it on.
      </p>
      <fieldset className="flex flex-col divide-y divide-hairline rounded-xl border border-hairline">
        <legend className="sr-only">Public information</legend>
        {OPTIONS.map((o) => (
          <label key={o.key} className="flex cursor-pointer items-center gap-4 px-4 py-3.5">
            <span className="min-w-0 flex-1">
              <span className="block font-medium">
                {o.label}
                {o.sensitive && (
                  <span className="ml-2 rounded-pill bg-canvas-soft px-2 py-0.5 text-xs font-medium text-body">
                    Medical
                  </span>
                )}
              </span>
              {o.hint && <span className="block text-sm text-body">{o.hint}</span>}
            </span>
            <input
              type="checkbox"
              role="switch"
              className="peer sr-only"
              checked={values[o.key]}
              onChange={(e) => setValues({ ...values, [o.key]: e.target.checked })}
              data-testid={`vis-${o.key}`}
            />
            <span
              aria-hidden
              className="relative h-7 w-12 shrink-0 rounded-pill bg-surface-pressed transition-colors after:absolute after:left-1 after:top-1 after:h-5 after:w-5 after:rounded-full after:bg-canvas after:shadow-float after:transition-transform peer-checked:bg-ink peer-checked:after:translate-x-5 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink"
            />
          </label>
        ))}
      </fieldset>
      {data.confirmedAt === null && (
        <p className="text-sm text-body">Saving confirms you have reviewed what is public.</p>
      )}
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="lg" loading={save.isPending} className="flex-1 sm:flex-none">
          {submitLabel}
        </Button>
        <SavedNote show={saved} />
      </div>
    </form>
  );
}
