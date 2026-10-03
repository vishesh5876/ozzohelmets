import { useState } from 'react';
import { PASSWORD_MIN_LENGTH } from '@helmet/types';
import type { PasswordValue } from './password-check';
import { Field, Input } from '@helmet/ui';

/** New password + confirmation. Passphrases encouraged; no forced symbol/number rules. */
export function PasswordFields({
  value,
  onChange,
  idPrefix = 'pw',
  label = 'Create a password',
}: {
  value: PasswordValue;
  onChange: (v: PasswordValue) => void;
  idPrefix?: string;
  label?: string;
}) {
  const [show, setShow] = useState(false);
  const mismatch = value.confirm.length > 0 && value.password !== value.confirm;
  return (
    <div className="flex flex-col gap-4">
      <Field
        label={label}
        htmlFor={`${idPrefix}-new`}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence is easy to remember and hard to guess.`}
      >
        <Input
          id={`${idPrefix}-new`}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={value.password}
          onChange={(e) => onChange({ ...value, password: e.target.value })}
        />
      </Field>
      <Field
        label="Confirm password"
        htmlFor={`${idPrefix}-confirm`}
        error={mismatch ? 'The passwords don’t match.' : undefined}
      >
        <Input
          id={`${idPrefix}-confirm`}
          type={show ? 'text' : 'password'}
          autoComplete="new-password"
          value={value.confirm}
          aria-invalid={mismatch}
          onChange={(e) => onChange({ ...value, confirm: e.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm text-body">
        <input
          type="checkbox"
          className="h-4 w-4 accent-black"
          checked={show}
          onChange={(e) => setShow(e.target.checked)}
        />{' '}
        Show password
      </label>
    </div>
  );
}
