import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from 'zod';
import type { BatchDto, HelmetModelDto } from '@helmet/types';
import { Button, Card, CardContent, Field, Input, Select, Textarea } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';

const schema = z.object({
  helmetModelId: z.string().uuid('Choose a helmet model'),
  manufacturingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a date'),
  quantity: z.coerce
    .number()
    .int('Whole numbers only')
    .min(1, 'At least 1')
    .max(50_000, 'At most 50,000 per batch'),
  batchCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([A-Z0-9][A-Z0-9-]{2,31})?$/, '3–32 characters: letters, digits and dashes')
    .optional(),
  notes: z.string().max(1000).optional(),
  generateNow: z.boolean(),
});
type FormInput = z.input<typeof schema>;
type FormValues = z.output<typeof schema>;

export function CreateBatchPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const models = useQuery({
    queryKey: ['helmet-models', 'active-options'],
    queryFn: () =>
      api.page<HelmetModelDto>('/admin/helmet-models', { status: 'ACTIVE', pageSize: 100 }),
  });
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormInput, unknown, FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      manufacturingDate: new Date().toISOString().slice(0, 10),
      quantity: 100,
      generateNow: true,
    },
  });

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const batch = await api.post<BatchDto>('/admin/batches', {
        helmetModelId: values.helmetModelId,
        manufacturingDate: values.manufacturingDate,
        quantity: values.quantity,
        batchCode: values.batchCode || undefined,
        notes: values.notes || undefined,
      });
      if (values.generateNow) await api.post<BatchDto>(`/admin/batches/${batch.id}/generate`);
      return batch;
    },
    onSuccess: async (batch) => {
      await qc.invalidateQueries({ queryKey: ['batches'] });
      navigate(`/batches/${batch.id}`);
    },
  });

  return (
    <>
      <PageHeader
        title="New manufacturing batch"
        description="Plan a production run and generate a secure identity for every helmet."
        back={{ to: '/batches', label: 'Batches' }}
      />
      <Card className="max-w-2xl">
        <CardContent>
          <form
            onSubmit={handleSubmit((v) => mutation.mutate(v))}
            noValidate
            className="flex flex-col gap-5"
          >
            <Field label="Helmet model" htmlFor="b-model" error={errors.helmetModelId?.message}>
              <Select
                id="b-model"
                aria-invalid={!!errors.helmetModelId}
                defaultValue=""
                {...register('helmetModelId')}
              >
                <option value="" disabled>
                  {models.isLoading ? 'Loading models…' : 'Select a model'}
                </option>
                {models.data?.items.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} — {m.sku}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field
                label="Manufacturing date"
                htmlFor="b-date"
                error={errors.manufacturingDate?.message}
              >
                <Input
                  id="b-date"
                  type="date"
                  aria-invalid={!!errors.manufacturingDate}
                  {...register('manufacturingDate')}
                />
              </Field>
              <Field label="Quantity" htmlFor="b-qty" error={errors.quantity?.message}>
                <Input
                  id="b-qty"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={50000}
                  aria-invalid={!!errors.quantity}
                  {...register('quantity')}
                />
              </Field>
            </div>
            <Field
              label="Batch code (optional)"
              htmlFor="b-code"
              error={errors.batchCode?.message}
              hint="Leave blank to assign the next BAT-YYYY-NNNNN code automatically."
            >
              <Input
                id="b-code"
                className="font-mono uppercase"
                placeholder="BAT-2026-00045"
                aria-invalid={!!errors.batchCode}
                {...register('batchCode')}
              />
            </Field>
            <Field label="Notes (optional)" htmlFor="b-notes" error={errors.notes?.message}>
              <Textarea id="b-notes" rows={3} {...register('notes')} />
            </Field>
            <label className="flex items-start gap-3 rounded-md bg-canvas-soft p-4">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 accent-black"
                {...register('generateNow')}
              />
              <span>
                <span className="block font-medium">Generate helmets immediately</span>
                <span className="block text-sm text-body">
                  Creates a Helmet ID, QR token, activation PIN, QR code and barcode for every unit.
                </span>
              </span>
            </label>
            <InlineError error={mutation.error} />
            <div className="flex justify-end gap-2">
              <Button variant="subtle" onClick={() => navigate('/batches')}>
                Cancel
              </Button>
              <Button type="submit" loading={mutation.isPending}>
                Create batch
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </>
  );
}
