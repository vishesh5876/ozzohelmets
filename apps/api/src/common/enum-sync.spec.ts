import { $Enums } from '@prisma/client';
import * as Shared from '@helmet/types';

/** Guards against drift between the Prisma schema and the shared contracts package. */
describe('Prisma ↔ @helmet/types enum sync', () => {
  const pairs: [string, Record<string, string>, Record<string, string>][] = [
    ['HelmetStatus', $Enums.HelmetStatus, Shared.HelmetStatus],
    ['AdminRole', $Enums.AdminRole, Shared.AdminRole],
    ['AdminUserStatus', $Enums.AdminUserStatus, Shared.AdminUserStatus],
    ['HelmetModelStatus', $Enums.HelmetModelStatus, Shared.HelmetModelStatus],
    ['BatchGenerationStatus', $Enums.BatchGenerationStatus, Shared.BatchGenerationStatus],
    ['BatchPrintStatus', $Enums.BatchPrintStatus, Shared.BatchPrintStatus],
    ['UserStatus', $Enums.UserStatus, Shared.UserStatus],
    ['OwnershipStatus', $Enums.OwnershipStatus, Shared.OwnershipStatus],
    ['ActorType', $Enums.ActorType, Shared.ActorType],
    ['ScanType', $Enums.ScanType, Shared.ScanType],
    ['BloodGroup', $Enums.BloodGroup, Shared.BloodGroup],
    ['Gender', $Enums.Gender, Shared.Gender],
    ['CustomerStatus (users.status)', $Enums.UserStatus, Shared.CustomerStatus],
  ];

  it.each(pairs)('%s matches', (_name, prisma, shared) => {
    expect(Object.values(prisma).sort()).toEqual(Object.values(shared).sort());
  });
});
