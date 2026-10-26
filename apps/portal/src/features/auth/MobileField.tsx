import { Field, Input } from '@helmet/ui';
import { MOBILE_HINT } from './mobile-check';

/** The account owner's mobile number. Not verified and never a sign-in identifier. */
export function MobileField({
  id,
  label = 'Mobile number',
  value,
  onChange,
  error,
  hint = MOBILE_HINT,
  autoFocus,
}: {
  id: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  error?: string | null;
  hint?: string;
  autoFocus?: boolean;
}) {
  return (
    <Field label={label} htmlFor={id} error={error ?? undefined} hint={hint}>
      <Input
        id={id}
        type="tel"
        inputMode="tel"
        autoComplete="tel"
        placeholder="98765 43210"
        maxLength={32}
        value={value}
        aria-invalid={!!error}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
