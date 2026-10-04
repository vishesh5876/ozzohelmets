import { useState } from 'react';
import { Button } from '@helmet/ui';

/**
 * One-time display of a recovery code. It is never shown again (only a hash is stored), so the
 * customer must confirm they saved it before continuing.
 */
export function RecoveryCodeNotice({
  code,
  onContinue,
  continueLabel = 'Continue',
}: {
  code: string;
  onContinue: () => void;
  continueLabel?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-display-sm font-bold">Your recovery code</p>
        <p className="mt-1 text-body">
          Save this recovery code. It can be used if you forget your password.
        </p>
      </div>
      <p
        className="rounded-xl border-2 border-dashed border-ink bg-canvas-softer px-4 py-5 text-center font-mono text-2xl font-bold tracking-wider"
        data-testid="recovery-code"
      >
        {code}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="subtle"
          size="sm"
          onClick={() =>
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            })
          }
        >
          {copied ? 'Copied' : 'Copy code'}
        </Button>
        <Button variant="subtle" size="sm" onClick={() => window.print()}>
          Print
        </Button>
      </div>
      <ul className="list-disc space-y-1 pl-5 text-sm text-body">
        <li>Write it down or store it in a password manager. Keep it with your helmet papers.</li>
        <li>It is shown only once. We can’t show it again.</li>
        <li>Anyone with this code and your email (or Helmet ID) can reset your password.</li>
      </ul>
      <label className="flex items-start gap-3 rounded-md bg-canvas-soft p-4">
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 accent-black"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
          data-testid="recovery-saved"
        />
        <span className="font-medium">I’ve saved my recovery code</span>
      </label>
      <Button size="lg" disabled={!saved} onClick={onContinue}>
        {continueLabel}
      </Button>
    </div>
  );
}
