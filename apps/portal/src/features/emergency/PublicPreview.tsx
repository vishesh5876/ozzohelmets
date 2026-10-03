import type { PublicEmergencyDto } from '@helmet/types';
import { humanizeEnum } from '@helmet/ui';
import { LoadingState } from '../../components/States';
import { usePreview } from './hooks';

function Section({ title, items }: { title: string; items?: string[] }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-xl border border-hairline p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-body">{title}</p>
      <ul className="mt-1 list-disc pl-5 font-semibold">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}

/** Mirrors exactly what the public QR page would show, using the server-side sanitizer. */
export function PublicPreview() {
  const { data, isLoading } = usePreview();
  if (isLoading || !data) return <LoadingState label="Building preview…" />;
  return <PreviewBody data={data} />;
}

export function PreviewBody({ data }: { data: Pick<PublicEmergencyDto, 'profile' | 'contacts'> }) {
  const p = data.profile ?? {};
  const empty = Object.keys(p).length === 0 && !data.contacts?.length;
  return (
    <div className="overflow-hidden rounded-xl border-2 border-ink" data-testid="public-preview">
      <div className="bg-ink px-5 py-4 text-on-dark">
        <p className="text-xs font-semibold uppercase tracking-wide text-mute">
          Preview · what responders see
        </p>
        <p className="text-display-sm font-bold">Emergency profile</p>
      </div>
      <div className="flex flex-col gap-3 p-4">
        {empty && (
          <p className="text-body">
            Nothing is public yet. Responders would only see that the helmet is registered.
          </p>
        )}
        {p.name && <p className="text-display-md font-bold">{p.name}</p>}
        {p.bloodGroupLabel && (
          <p>
            <span className="text-sm text-body">Blood group </span>
            <span className="text-display-md font-black">{p.bloodGroupLabel}</span>
          </p>
        )}
        {(p.age !== undefined || p.gender || p.organDonor !== undefined) && (
          <p className="text-sm text-body">
            {[
              p.age !== undefined ? `Age ${p.age}` : null,
              p.gender,
              p.organDonor === undefined
                ? null
                : p.organDonor
                  ? 'Organ donor'
                  : 'Not an organ donor',
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        )}
        <Section title="Allergies" items={p.allergies} />
        <Section title="Medical conditions" items={p.medicalConditions} />
        <Section title="Medications" items={p.medications} />
        {p.emergencyNotes && (
          <div className="rounded-xl border border-hairline p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-body">Emergency notes</p>
            <p className="mt-1 whitespace-pre-wrap">{p.emergencyNotes}</p>
          </div>
        )}
        {data.contacts?.map((c) => (
          <div
            key={c.phone}
            className="flex items-center justify-between gap-3 rounded-xl bg-canvas-soft p-4"
          >
            <div>
              <p className="font-bold">{c.name}</p>
              <p className="text-sm text-body">{c.relationship}</p>
            </div>
            <span className="rounded-pill bg-ink px-4 py-2 text-sm font-bold text-on-dark">
              Call
            </span>
          </div>
        ))}
        {p.photoUrl && <p className="text-sm text-body">Your photo is shown.</p>}
      </div>
    </div>
  );
}
