import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import {
  type CustomerHelmetDetailDto,
  type CustomerWarrantyDto,
  PurchaseChannel,
  type RegisterWarrantyRequest,
} from '@helmet/types';
import { Badge, Button, Card, CardContent, Field, Input, Select } from '@helmet/ui';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { CHANNEL_LABEL, formatDay, WARRANTY_LABEL, warrantyLine } from './warranty-labels';

const todayIso = () => new Date().toISOString().slice(0, 10);

const schema = z.object({
  purchaseDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the purchase date')
    .refine((v) => v <= todayIso(), 'The purchase date cannot be in the future'),
  purchaseChannel: z.string(),
  sellerName: z.string().trim().max(120),
  sellerCity: z.string().trim().max(80),
  invoiceNumber: z.string().trim().max(64),
});
type FormValues = z.infer<typeof schema>;

export function WarrantyPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const helmet = useQuery({
    queryKey: keys.helmet(id),
    queryFn: () => api.get<CustomerHelmetDetailDto>(`/customer/helmets/${id}`),
  });
  const warranty = useQuery({
    queryKey: ['helmets', id, 'warranty'],
    queryFn: () => api.get<CustomerWarrantyDto>(`/customer/helmets/${id}/warranty`),
  });
  const refresh = async (w: CustomerWarrantyDto) => {
    qc.setQueryData(['helmets', id, 'warranty'], w);
    await qc.invalidateQueries({ queryKey: keys.helmets });
  };

  if (helmet.isLoading || warranty.isLoading) return <LoadingState />;
  if (!helmet.data || !warranty.data) return <ErrorState error={helmet.error ?? warranty.error} />;
  const w = warranty.data;

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <Link to={`/app/helmets/${id}`} className="text-sm font-medium text-body hover:text-ink">
        ← {helmet.data.helmetCode}
      </Link>
      <h1 className="text-display-md font-bold">Warranty</h1>
      <WarrantyCard w={w} helmetId={id} onChange={refresh} />
      {w.canRegister && <RegisterForm helmetId={id} months={w.policy.months} onDone={refresh} />}
      {w.status === 'NOT_REGISTERED' && !w.canRegister && (
        <Card>
          <CardContent>
            <p className="text-body">
              {w.policy.enabled
                ? 'A warranty can’t be registered for this helmet in its current state.'
                : 'This helmet model does not include a registrable warranty.'}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function WarrantyCard({
  w,
  helmetId,
  onChange,
}: {
  w: CustomerWarrantyDto;
  helmetId: string;
  onChange: (w: CustomerWarrantyDto) => Promise<void>;
}) {
  if (w.status === 'NOT_REGISTERED') {
    return (
      <Card>
        <CardContent className="flex flex-col gap-2">
          <Badge tone="outline" className="self-start">
            Not registered
          </Badge>
          <p className="text-display-sm font-bold">Register your warranty</p>
          <p className="text-body">
            {w.policy.enabled
              ? `Helmets of this model are covered for ${w.policy.months} months from the purchase date.`
              : 'No warranty is offered for this model.'}
          </p>
        </CardContent>
      </Card>
    );
  }
  const label = WARRANTY_LABEL[w.status];
  return (
    <Card data-testid="warranty-card">
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={label.tone}>{label.label}</Badge>
          <p className="font-bold">{warrantyLine({ status: w.status, endDate: w.endDate })}</p>
        </div>
        {w.replacedByHelmetCode && (
          <p className="text-sm text-body">
            Coverage continues on the replacement helmet{' '}
            <span className="font-mono">{w.replacedByHelmetCode}</span>.
          </p>
        )}
        {w.replacesHelmetCode && (
          <p className="text-sm text-body">
            Replacement for <span className="font-mono">{w.replacesHelmetCode}</span>.
          </p>
        )}
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <Item
            label="Registered"
            value={w.registeredAt ? formatDay(w.registeredAt.slice(0, 10)) : '—'}
          />
          <Item label="Purchase date" value={formatDay(w.purchaseDate)} />
          <Item label="Coverage starts" value={formatDay(w.startDate)} />
          <Item label="Coverage ends" value={formatDay(w.endDate)} />
          {w.details && (
            <>
              <Item
                label="Purchased via"
                value={w.details.purchaseChannel ? CHANNEL_LABEL[w.details.purchaseChannel] : '—'}
              />
              <Item label="Seller" value={w.details.sellerName ?? '—'} />
              <Item label="Invoice number" value={w.details.invoiceNumber ?? '—'} />
              <Item
                label="Proof of purchase"
                value={w.details.hasProof ? 'Uploaded' : 'Not uploaded'}
              />
            </>
          )}
        </dl>
        {w.details ? (
          <ProofControls helmetId={helmetId} hasProof={w.details.hasProof} onChange={onChange} />
        ) : (
          <p className="text-xs text-body">
            Purchase details and documents from a previous owner are private and not shown.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ProofControls({
  helmetId,
  hasProof,
  onChange,
}: {
  helmetId: string;
  hasProof: boolean;
  onChange: (w: CustomerWarrantyDto) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('proof', file);
      return api.upload<CustomerWarrantyDto>(
        `/customer/helmets/${helmetId}/warranty/proof`,
        form,
        'POST',
      );
    },
    onSuccess: onChange,
  });
  const remove = useMutation({
    mutationFn: () =>
      api.delete<CustomerWarrantyDto>(`/customer/helmets/${helmetId}/warranty/proof`),
    onSuccess: onChange,
  });
  const download = useMutation({
    mutationFn: () => api.blob(`/customer/helmets/${helmetId}/warranty/proof`),
    onSuccess: ({ blob }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        blob.type === 'application/pdf' ? 'proof-of-purchase.pdf' : 'proof-of-purchase.webp';
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <div className="flex flex-col gap-2 border-t border-hairline pt-4">
      <p className="text-sm font-medium">Proof of purchase (optional, private)</p>
      <p className="text-xs text-body">
        JPEG, PNG, WebP or PDF, up to 10 MB. Only you and authorised support staff can see it.
      </p>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        data-testid="proof-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = '';
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="subtle"
          loading={upload.isPending}
          onClick={() => input.current?.click()}
        >
          {hasProof ? 'Replace document' : 'Upload document'}
        </Button>
        {hasProof && (
          <>
            <Button
              size="sm"
              variant="ghost"
              loading={download.isPending}
              onClick={() => download.mutate()}
            >
              Download
            </Button>
            <Button
              size="sm"
              variant="ghost"
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </Button>
          </>
        )}
      </div>
      <InlineError error={upload.error ?? remove.error ?? download.error} />
    </div>
  );
}

function RegisterForm({
  helmetId,
  months,
  onDone,
}: {
  helmetId: string;
  months: number;
  onDone: (w: CustomerWarrantyDto) => Promise<void>;
}) {
  const [review, setReview] = useState<RegisterWarrantyRequest | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      purchaseDate: '',
      purchaseChannel: '',
      sellerName: '',
      sellerCity: '',
      invoiceNumber: '',
    },
  });
  const submit = useMutation({
    mutationFn: (body: RegisterWarrantyRequest) =>
      api.post<CustomerWarrantyDto>(`/customer/helmets/${helmetId}/warranty`, body),
    onSuccess: onDone,
  });

  if (review) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-4">
          <p className="text-display-sm font-bold">Review</p>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Item label="Purchase date" value={formatDay(review.purchaseDate)} />
            <Item
              label="Purchased via"
              value={review.purchaseChannel ? CHANNEL_LABEL[review.purchaseChannel] : '—'}
            />
            <Item label="Seller / store" value={review.sellerName ?? '—'} />
            <Item label="Invoice number" value={review.invoiceNumber ?? '—'} />
          </dl>
          <p className="text-sm text-body">
            Coverage of {months} months will be calculated from the purchase date. You can add a
            proof of purchase after registering.
          </p>
          <InlineError error={submit.error} />
          <div className="flex flex-wrap gap-2">
            <Button loading={submit.isPending} onClick={() => submit.mutate(review)}>
              Register warranty
            </Button>
            <Button variant="ghost" onClick={() => setReview(null)}>
              Edit
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={handleSubmit((v) =>
            setReview({
              purchaseDate: v.purchaseDate,
              purchaseChannel: (v.purchaseChannel || undefined) as PurchaseChannel | undefined,
              sellerName: v.sellerName || undefined,
              sellerCity: v.sellerCity || undefined,
              invoiceNumber: v.invoiceNumber || undefined,
            }),
          )}
        >
          <Field label="Purchase date" htmlFor="w-date" error={errors.purchaseDate?.message}>
            <Input id="w-date" type="date" max={todayIso()} {...register('purchaseDate')} />
          </Field>
          <Field label="Purchase channel" htmlFor="w-channel">
            <Select id="w-channel" {...register('purchaseChannel')}>
              <option value="">Prefer not to say</option>
              {Object.values(PurchaseChannel).map((c) => (
                <option key={c} value={c}>
                  {CHANNEL_LABEL[c]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Seller / store name (optional)"
            htmlFor="w-seller"
            error={errors.sellerName?.message}
          >
            <Input id="w-seller" maxLength={120} {...register('sellerName')} />
          </Field>
          <Field label="City (optional)" htmlFor="w-city">
            <Input id="w-city" maxLength={80} {...register('sellerCity')} />
          </Field>
          <Field label="Invoice number (optional)" htmlFor="w-invoice">
            <Input id="w-invoice" maxLength={64} {...register('invoiceNumber')} />
          </Field>
          <Button type="submit">Review</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-body">{label}</dt>
      <dd className="mt-0.5 font-medium">{value}</dd>
    </div>
  );
}
