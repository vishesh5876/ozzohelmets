import { Check, Minus } from 'lucide-react';
import { ADMIN_ROLES, Permission, ROLE_PERMISSIONS } from '@helmet/types';
import { humanizeEnum } from '@helmet/ui';
import { PageHeader } from '../../components/PageHeader';
import { Table, Td, Th, THead, Tr } from '../../components/Table';

const LABELS: Record<Permission, string> = {
  'dashboard:read': 'View dashboard',
  'models:read': 'View helmet models',
  'models:write': 'Create & edit helmet models',
  'batches:read': 'View batches',
  'batches:write': 'Create batches / mark printed',
  'batches:generate': 'Generate helmets',
  'helmets:read': 'View helmets',
  'helmets:update-status': 'Change helmet status',
  'labels:read': 'View & download QR / barcodes',
  'export:manufacturing': 'Export manufacturing CSV (activation PINs)',
  'audit:read': 'View audit logs',
  'admin-users:manage': 'Manage admin users',
};

export function RolesPage() {
  return (
    <>
      <PageHeader
        title="Roles & permissions"
        description="Permissions are enforced by the API on every request. This matrix is read-only."
      />
      <Table>
        <THead>
          <tr>
            <Th>Permission</Th>
            {ADMIN_ROLES.map((r) => (
              <Th key={r} className="text-center">
                {humanizeEnum(r)}
              </Th>
            ))}
          </tr>
        </THead>
        <tbody>
          {Object.values(Permission).map((p) => (
            <Tr key={p}>
              <Td className="font-medium">{LABELS[p]}</Td>
              {ADMIN_ROLES.map((r) => (
                <Td key={r} className="text-center">
                  {ROLE_PERMISSIONS[r].includes(p) ? (
                    <Check className="mx-auto h-4 w-4" aria-label="Allowed" />
                  ) : (
                    <Minus className="mx-auto h-4 w-4 text-mute" aria-label="Not allowed" />
                  )}
                </Td>
              ))}
            </Tr>
          ))}
        </tbody>
      </Table>
    </>
  );
}
