import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import type { HelmetModelDto } from '@helmet/types';
import { Button, Field, Input, Select, Textarea } from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { InlineError } from '../../components/States';
import { api } from '../../lib/api';

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(120),
  sku: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,63}$/, '2–64 characters: letters, digits and dashes'),
  brand: z.string().trim().min(1, 'Required').max(80),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  warrantyEnabled: z.enum(['yes', 'no']),
  warrantyMonths: z.coerce.number().int().min(0, '0–240 months').max(240, '0–240 months'),
});
type FormValues = z.infer<typeof schema>;

export function ModelFormDialog({
  open,
  onClose,
  model,
}: {
  open: boolean;
  onClose: () => void;
  model: HelmetModelDto | null;
}) {
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (open)
      reset({
        name: model?.name ?? '',
        sku: model?.sku ?? '',
        brand: model?.brand ?? '',
        description: model?.description ?? '',
        status: model?.status ?? 'ACTIVE',
        warrantyEnabled: model?.warrantyEnabled === false ? 'no' : 'yes',
        warrantyMonths: model?.warrantyMonths ?? 24,
      });
  }, [open, model, reset]);

  const mutation = useMutation({
    mutationFn: (values: FormValues) => {
      const description = values.description || undefined;
      const warranty = {
        warrantyEnabled: values.warrantyEnabled === 'yes',
        warrantyMonths: values.warrantyMonths,
      };
      return model
        ? api.patch<HelmetModelDto>(`/admin/helmet-models/${model.id}`, {
            name: values.name,
            brand: values.brand,
            description,
            status: values.status,
            ...warranty,
          })
        : api.post<HelmetModelDto>('/admin/helmet-models', {
            name: values.name,
            sku: values.sku,
            brand: values.brand,
            description,
            ...warranty,
          });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['helmet-models'] });
      onClose();
    },
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={model ? 'Edit helmet model' : 'New helmet model'}
      description={model ? undefined : 'SKUs are permanent once created.'}
    >
      <form
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="flex flex-col gap-4"
      >
        <Field label="Name" htmlFor="m-name" error={errors.name?.message}>
          <Input
            id="m-name"
            placeholder="Roadster X1"
            aria-invalid={!!errors.name}
            {...register('name')}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="SKU" htmlFor="m-sku" error={errors.sku?.message}>
            <Input
              id="m-sku"
              placeholder="RX1-MATTE-BLK"
              className="font-mono uppercase"
              disabled={!!model}
              aria-invalid={!!errors.sku}
              {...register('sku')}
            />
          </Field>
          <Field label="Brand" htmlFor="m-brand" error={errors.brand?.message}>
            <Input
              id="m-brand"
              placeholder="Ozzo"
              aria-invalid={!!errors.brand}
              {...register('brand')}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="m-desc" error={errors.description?.message}>
          <Textarea id="m-desc" rows={3} {...register('description')} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Warranty" htmlFor="m-warranty">
            <Select id="m-warranty" {...register('warrantyEnabled')}>
              <option value="yes">Included</option>
              <option value="no">Not offered</option>
            </Select>
          </Field>
          <Field
            label="Warranty length (months)"
            htmlFor="m-warranty-months"
            error={errors.warrantyMonths?.message}
            hint="Applies to new registrations; coverage is computed by the server."
          >
            <Input
              id="m-warranty-months"
              type="number"
              min={0}
              max={240}
              {...register('warrantyMonths')}
            />
          </Field>
        </div>
        {model && (
          <Field
            label="Status"
            htmlFor="m-status"
            hint="Archived models can't receive new batches."
          >
            <Select id="m-status" {...register('status')}>
              <option value="ACTIVE">Active</option>
              <option value="ARCHIVED">Archived</option>
            </Select>
          </Field>
        )}
        <InlineError error={mutation.error} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            {model ? 'Save changes' : 'Create model'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
