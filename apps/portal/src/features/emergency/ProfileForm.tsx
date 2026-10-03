import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { BLOOD_GROUP_LABELS, BLOOD_GROUPS, type EmergencyProfileDto, GENDERS } from '@helmet/types';
import { Button, Field, humanizeEnum, Input, Select, Textarea } from '@helmet/ui';
import { InlineError, LoadingState, SavedNote } from '../../components/States';
import { api } from '../../lib/api';
import { useInvalidateEmergency, useProfile } from './hooks';
import { PhotoUploader } from './PhotoUploader';

const lines = (v: string) =>
  v
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  name: z.string().trim().min(1, 'Enter the name first responders should use').max(120),
  bloodGroup: z.string(),
  dateOfBirth: z
    .string()
    .refine(
      (v) => !v || (new Date(v) <= new Date() && new Date(v).getFullYear() >= 1900),
      'Enter a valid date of birth',
    ),
  gender: z.string(),
  allergies: z.string().max(2000),
  medicalConditions: z.string().max(2000),
  medications: z.string().max(2000),
  emergencyNotes: z.string().max(1000, 'Keep notes under 1000 characters'),
  organDonor: z.enum(['', 'yes', 'no']),
});
type FormValues = z.infer<typeof schema>;

const toForm = (p: EmergencyProfileDto): FormValues => ({
  name: p.name ?? '',
  bloodGroup: p.bloodGroup ?? '',
  dateOfBirth: p.dateOfBirth ?? '',
  gender: p.gender ?? '',
  allergies: p.allergies.join('\n'),
  medicalConditions: p.medicalConditions.join('\n'),
  medications: p.medications.join('\n'),
  emergencyNotes: p.emergencyNotes ?? '',
  organDonor: p.organDonor === null ? '' : p.organDonor ? 'yes' : 'no',
});

/** Emergency details. Only the name is required; medical fields are encrypted at rest. */
export function ProfileForm({
  onSaved,
  submitLabel = 'Save details',
}: {
  onSaved?: () => void;
  submitLabel?: string;
}) {
  const { data: profile, isLoading } = useProfile();
  const invalidate = useInvalidateEmergency();
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (profile) reset(toForm(profile));
  }, [profile, reset]);

  const save = useMutation({
    mutationFn: (v: FormValues) =>
      api.put<EmergencyProfileDto>('/customer/emergency-profile', {
        name: v.name,
        bloodGroup: v.bloodGroup || null,
        dateOfBirth: v.dateOfBirth || null,
        gender: v.gender || null,
        allergies: lines(v.allergies),
        medicalConditions: lines(v.medicalConditions),
        medications: lines(v.medications),
        emergencyNotes: v.emergencyNotes.trim() || null,
        organDonor: v.organDonor === '' ? null : v.organDonor === 'yes',
      }),
    onSuccess: async (p) => {
      reset(toForm(p));
      await invalidate();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onSaved?.();
    },
  });

  if (isLoading || !profile) return <LoadingState />;

  return (
    <form onSubmit={handleSubmit((v) => save.mutate(v))} noValidate className="flex flex-col gap-5">
      <Field
        label="Full name"
        htmlFor="p-name"
        error={errors.name?.message}
        hint="Required. Shown publicly only if you allow it."
      >
        <Input id="p-name" autoComplete="name" aria-invalid={!!errors.name} {...register('name')} />
      </Field>
      <PhotoUploader hasPhoto={profile.hasPhoto} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          label="Blood group"
          htmlFor="p-blood"
          hint="Optional — leave blank if you don’t know it."
        >
          <Select id="p-blood" {...register('bloodGroup')}>
            <option value="">Not set</option>
            {BLOOD_GROUPS.map((g) => (
              <option key={g} value={g}>
                {BLOOD_GROUP_LABELS[g]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Date of birth" htmlFor="p-dob" error={errors.dateOfBirth?.message}>
          <Input
            id="p-dob"
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            {...register('dateOfBirth')}
          />
        </Field>
        <Field label="Gender" htmlFor="p-gender">
          <Select id="p-gender" {...register('gender')}>
            <option value="">Not set</option>
            {GENDERS.map((g) => (
              <option key={g} value={g}>
                {humanizeEnum(g)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Organ donor" htmlFor="p-donor">
          <Select id="p-donor" {...register('organDonor')}>
            <option value="">Not set</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </Select>
        </Field>
      </div>
      <Field label="Allergies" htmlFor="p-allergies" hint="One per line, e.g. Penicillin">
        <Textarea id="p-allergies" rows={3} {...register('allergies')} />
      </Field>
      <Field label="Medical conditions" htmlFor="p-conditions" hint="One per line">
        <Textarea id="p-conditions" rows={3} {...register('medicalConditions')} />
      </Field>
      <Field label="Medications" htmlFor="p-meds" hint="One per line">
        <Textarea id="p-meds" rows={3} {...register('medications')} />
      </Field>
      <Field
        label="Emergency notes"
        htmlFor="p-notes"
        error={errors.emergencyNotes?.message}
        hint="Anything a first responder should know."
      >
        <Textarea id="p-notes" rows={3} {...register('emergencyNotes')} />
      </Field>
      <p className="rounded-md bg-canvas-soft p-3 text-sm text-body">
        Medical details are encrypted. Nothing appears on your public page until you choose it in
        privacy settings.
      </p>
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="submit" size="lg" loading={save.isPending} className="flex-1 sm:flex-none">
          {submitLabel}
        </Button>
        <SavedNote show={saved && !isDirty} />
      </div>
    </form>
  );
}
