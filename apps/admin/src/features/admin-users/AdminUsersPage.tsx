import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { ADMIN_ROLES, type AdminRole, type AdminUserDto } from '@helmet/types';
import { Badge, Button, Field, humanizeEnum, Input, Select } from '@helmet/ui';
import { Dialog } from '../../components/Dialog';
import { PageHeader } from '../../components/PageHeader';
import { ErrorState, InlineError, LoadingState } from '../../components/States';
import { Table, Td, Th, THead, Tr } from '../../components/Table';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth-context';
import { formatDateTime } from '../../lib/format';

const schema = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(120),
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z
    .string()
    .min(12, 'At least 12 characters')
    .regex(/(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/, 'Include upper and lower case letters and a digit'),
  role: z.enum(ADMIN_ROLES as [AdminRole, ...AdminRole[]]),
});
type FormValues = z.infer<typeof schema>;

export function AdminUsersPage() {
  const qc = useQueryClient();
  const { admin: me } = useAuth();
  const [open, setOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<AdminUserDto[]>('/admin/users'),
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string; role?: string }) =>
      api.patch<AdminUserDto>(`/admin/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-users'] }),
  });

  return (
    <>
      <PageHeader
        title="Admin users"
        description="Separate from customer accounts. Disabling a user or changing their role ends their sessions."
        actions={<Button onClick={() => setOpen(true)}>Invite admin</Button>}
      />
      <InlineError error={update.error} />
      {isLoading && <LoadingState />}
      {error && <ErrorState error={error} onRetry={() => void refetch()} />}
      {data && (
        <Table className="mt-2">
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Status</Th>
              <Th>Last sign-in</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {data.map((u) => (
              <Tr key={u.id}>
                <Td>
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-body">{u.email}</p>
                </Td>
                <Td>
                  <Select
                    aria-label={`Role for ${u.name}`}
                    className="h-9 max-w-48 text-sm"
                    value={u.role}
                    disabled={u.id === me?.id || update.isPending}
                    onChange={(e) => update.mutate({ id: u.id, role: e.target.value })}
                  >
                    {ADMIN_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {humanizeEnum(r)}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td>
                  <Badge tone={u.status === 'ACTIVE' ? 'solid' : 'muted'}>
                    {humanizeEnum(u.status)}
                  </Badge>
                </Td>
                <Td className="text-body">{formatDateTime(u.lastLoginAt)}</Td>
                <Td className="text-right">
                  {u.id !== me?.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        update.mutate({
                          id: u.id,
                          status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                        })
                      }
                    >
                      {u.status === 'ACTIVE' ? 'Disable' : 'Enable'}
                    </Button>
                  )}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateAdminDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function CreateAdminDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { role: 'SUPPORT' } });
  const mutation = useMutation({
    mutationFn: (values: FormValues) => api.post<AdminUserDto>('/admin/users', values),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['admin-users'] });
      reset();
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite admin"
      description="Share the initial password through a secure channel."
    >
      <form
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="flex flex-col gap-4"
      >
        <Field label="Name" htmlFor="u-name" error={errors.name?.message}>
          <Input id="u-name" aria-invalid={!!errors.name} {...register('name')} />
        </Field>
        <Field label="Email" htmlFor="u-email" error={errors.email?.message}>
          <Input id="u-email" type="email" aria-invalid={!!errors.email} {...register('email')} />
        </Field>
        <Field label="Initial password" htmlFor="u-pass" error={errors.password?.message}>
          <Input
            id="u-pass"
            type="password"
            autoComplete="new-password"
            aria-invalid={!!errors.password}
            {...register('password')}
          />
        </Field>
        <Field label="Role" htmlFor="u-role">
          <Select id="u-role" {...register('role')}>
            {ADMIN_ROLES.map((r) => (
              <option key={r} value={r}>
                {humanizeEnum(r)}
              </option>
            ))}
          </Select>
        </Field>
        <InlineError error={mutation.error} />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Create admin
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
