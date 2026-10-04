import { Field, Input } from '@helmet/ui';
import { EMAIL_MAX_LENGTH } from '@helmet/types';
import { EMAIL_WARNING } from './email-check';

/** The account email input. It is a sign-in identifier, not verified and not proof of ownership. */
export function EmailField({
  id,
  label = 'Email',
  value,
  onChange,
  error,
  hint = EMAIL_WARNING,
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
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={EMAIL_MAX_LENGTH}
        value={value}
        aria-invalid={!!error}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
