import { ADMIN_ROLES, Permission, ROLE_PERMISSIONS, SUPER_ADMIN_ONLY } from '@helmet/types';

const MUTATING = Object.values(Permission).filter((p) =>
  /:(write|generate|update-status|revoke|cancel|manage|void|delete|grant)$/.test(p),
);

describe('RBAC matrix', () => {
  it('SUPER_ADMIN holds everything; SUPER_ADMIN-only permissions belong to no other role', () => {
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual(Object.values(Permission).sort());
    for (const role of ADMIN_ROLES.filter((r) => r !== 'SUPER_ADMIN'))
      for (const p of SUPER_ADMIN_ONLY)
        if (p !== Permission.WARRANTY_DOCUMENT_VIEW || role !== 'SUPPORT')
          expect({ role, has: ROLE_PERMISSIONS[role].includes(p) }).toEqual({ role, has: false });
  });

  it('MANUFACTURING cannot reach customers, privacy or security data', () => {
    for (const p of [
      Permission.CUSTOMERS_READ,
      Permission.CUSTOMERS_MANAGE,
      Permission.PRIVACY_REQUESTS_VIEW,
      Permission.SECURITY_EVENTS_VIEW,
      Permission.OWNERSHIP_VIEW,
    ])
      expect(ROLE_PERMISSIONS.MANUFACTURING).not.toContain(p);
  });

  it('SUPPORT can help customers but never issue recovery grants or delete accounts', () => {
    expect(ROLE_PERMISSIONS.SUPPORT).toEqual(
      expect.arrayContaining([Permission.CUSTOMERS_READ, Permission.CUSTOMERS_MANAGE]),
    );
    for (const p of [
      Permission.CUSTOMER_RECOVERY_GRANT,
      Permission.CUSTOMERS_DELETE,
      Permission.PRIVACY_REQUESTS_MANAGE,
      Permission.SECURITY_EVENTS_VIEW,
    ])
      expect(ROLE_PERMISSIONS.SUPPORT).not.toContain(p);
  });

  it('ANALYTICS_VIEWER is read-only', () => {
    expect(ROLE_PERMISSIONS.ANALYTICS_VIEWER.filter((p) => MUTATING.includes(p))).toEqual([]);
  });

  it('ADMIN lacks the SUPER_ADMIN-only account recovery and deletion functions', () => {
    for (const p of [
      Permission.CUSTOMER_RECOVERY_GRANT,
      Permission.CUSTOMERS_DELETE,
      Permission.PRIVACY_REQUESTS_MANAGE,
    ])
      expect(ROLE_PERMISSIONS.ADMIN).not.toContain(p);
  });
});
