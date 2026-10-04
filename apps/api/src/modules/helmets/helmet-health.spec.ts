import { helmetHealthFlags } from './helmet-health';

const base = {
  status: 'ACTIVE' as const,
  hasOwner: true,
  activated: true,
  emergencySharing: true,
  warrantyStatus: 'ACTIVE' as const,
  scans24h: 0,
  highScanThreshold24h: 50,
};

describe('helmet health flags', () => {
  it('summarises operational facts', () => {
    expect(helmetHealthFlags(base)).toEqual(['ACTIVATED', 'EMERGENCY_ENABLED', 'WARRANTY_ACTIVE']);
    expect(
      helmetHealthFlags({
        ...base,
        status: 'PRINTED',
        hasOwner: false,
        activated: false,
        emergencySharing: false,
        warrantyStatus: 'NOT_REGISTERED',
      }),
    ).toEqual(['NO_OWNER']);
    expect(helmetHealthFlags({ ...base, status: 'STOLEN', scans24h: 50 })).toEqual([
      'ACTIVATED',
      'REPORTED_STOLEN',
      'WARRANTY_ACTIVE',
      'HIGH_SCAN_ACTIVITY',
    ]);
  });
});
