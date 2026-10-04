import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ArrowDown, ArrowUp, Pencil, Trash2 } from 'lucide-react';
import { type EmergencyContactDto, MAX_EMERGENCY_CONTACTS } from '@helmet/types';
import { Button, Field, Input } from '@helmet/ui';
import { InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { useContacts, useInvalidateEmergency } from './hooks';

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(120),
  relationship: z.string().trim().min(1, 'Required').max(60),
  phone: z.string().trim().min(6, 'Enter a phone number').max(32),
  alternatePhone: z.string().trim().max(32),
});
type FormValues = z.infer<typeof schema>;

function ContactForm({ initial, onDone }: { initial?: EmergencyContactDto; onDone: () => void }) {
  const invalidate = useInvalidateEmergency();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: initial?.name ?? '',
      relationship: initial?.relationship ?? '',
      phone: initial?.phone ?? '',
      alternatePhone: initial?.alternatePhone ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = { ...v, alternatePhone: v.alternatePhone || null };
      return initial
        ? api.patch(`/customer/emergency-contacts/${initial.id}`, body)
        : api.post('/customer/emergency-contacts', body);
    },
    onSuccess: async () => {
      await invalidate();
      onDone();
    },
  });
  const id = initial?.id ?? 'new';
  return (
    <form
      onSubmit={handleSubmit((v) => save.mutate(v))}
      noValidate
      className="flex flex-col gap-4 rounded-xl bg-canvas-softer p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor={`c-name-${id}`} error={errors.name?.message}>
          <Input id={`c-name-${id}`} aria-invalid={!!errors.name} {...register('name')} />
        </Field>
        <Field label="Relationship" htmlFor={`c-rel-${id}`} error={errors.relationship?.message}>
          <Input
            id={`c-rel-${id}`}
            placeholder="Father, partner, friend…"
            aria-invalid={!!errors.relationship}
            {...register('relationship')}
          />
        </Field>
        <Field label="Phone" htmlFor={`c-phone-${id}`} error={errors.phone?.message}>
          <Input
            id={`c-phone-${id}`}
            type="tel"
            inputMode="tel"
            aria-invalid={!!errors.phone}
            {...register('phone')}
          />
        </Field>
        <Field label="Alternate phone (optional)" htmlFor={`c-alt-${id}`}>
          <Input id={`c-alt-${id}`} type="tel" inputMode="tel" {...register('alternatePhone')} />
        </Field>
      </div>
      <InlineError error={save.error} />
      <div className="flex gap-2">
        <Button type="submit" loading={save.isPending}>
          {initial ? 'Save contact' : 'Add contact'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Up to five contacts, called in priority order. Two are recommended. */
export function ContactsManager() {
  const { data: contacts, isLoading } = useContacts();
  const invalidate = useInvalidateEmergency();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.put('/customer/emergency-contacts/order', { ids }),
    onSuccess: () => invalidate(),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/customer/emergency-contacts/${id}`),
    onSuccess: () => invalidate(),
  });

  if (isLoading || !contacts) return <LoadingState />;

  const move = (index: number, delta: number) => {
    const ids = contacts.map((c) => c.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(index + delta, 0, moved!);
    reorder.mutate(ids);
  };

  return (
    <div className="flex flex-col gap-4">
      {contacts.length === 0 && editing !== 'new' && (
        <p className="rounded-xl border border-dashed border-hairline p-5 text-body">
          <span className="block font-bold text-ink">Add someone responders can call</span>
          No emergency contacts yet. Add at least one — we recommend two.
        </p>
      )}
      <p className="text-sm text-body">
        Responders see these as “Provided by helmet owner”. Numbers are not verified — check them
        carefully. Contact 1 is called first; use the arrows to change the order.
      </p>
      <ol className="flex flex-col gap-3">
        {contacts.map((c, i) =>
          editing === c.id ? (
            <li key={c.id}>
              <ContactForm initial={c} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-hairline p-4"
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-sm font-bold text-on-dark"
                aria-label={`Priority ${c.priority}`}
              >
                {c.priority}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{c.name}</p>
                <p className="truncate text-sm text-body">
                  {c.relationship} · {c.phone}
                  {c.alternatePhone ? ` · ${c.alternatePhone}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${c.name} up`}
                  disabled={i === 0 || reorder.isPending}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Move ${c.name} down`}
                  disabled={i === contacts.length - 1 || reorder.isPending}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => setEditing(c.id)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${c.name}`}
                  onClick={() => remove.mutate(c.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </li>
          ),
        )}
      </ol>
      <InlineError error={reorder.error ?? remove.error} />
      {editing === 'new' ? (
        <ContactForm onDone={() => setEditing(null)} />
      ) : (
        contacts.length < MAX_EMERGENCY_CONTACTS && (
          <Button variant="subtle" onClick={() => setEditing('new')}>
            Add emergency contact
          </Button>
        )
      )}
    </div>
  );
}
