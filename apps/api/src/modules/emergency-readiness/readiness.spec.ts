import {
  evaluateReadiness,
  helmetProfileStatus,
  missingRequirements,
  profileStatus,
  type ReadinessFacts,
} from './readiness';

const complete: ReadinessFacts = {
  ownsHelmet: true,
  hasProfile: true,
  name: 'Rahul Sharma',
  activeContactCount: 1,
  privacyConfirmed: true,
  enabled: false,
};

describe('emergency readiness', () => {
  it('requires name, one contact and privacy review — but not blood group', () => {
    expect(missingRequirements(complete)).toEqual([]);
    expect(missingRequirements({ ...complete, name: '  ' })).toEqual(['NAME']);
    expect(missingRequirements({ ...complete, activeContactCount: 0 })).toEqual([
      'EMERGENCY_CONTACT',
    ]);
    expect(missingRequirements({ ...complete, privacyConfirmed: false })).toEqual([
      'PRIVACY_REVIEW',
    ]);
    expect(
      missingRequirements({
        ...complete,
        name: null,
        activeContactCount: 0,
        privacyConfirmed: false,
      }),
    ).toHaveLength(3);
  });

  it('derives profile status', () => {
    expect(profileStatus({ ...complete, hasProfile: false })).toBe('NOT_CONFIGURED');
    expect(profileStatus({ ...complete, activeContactCount: 0 })).toBe('INCOMPLETE');
    expect(profileStatus(complete)).toBe('DISABLED');
    expect(profileStatus({ ...complete, enabled: true })).toBe('ACTIVE');
  });

  it('reports completion in 20% steps and canEnable only when nothing is missing', () => {
    expect(
      evaluateReadiness({
        ...complete,
        name: null,
        activeContactCount: 0,
        privacyConfirmed: false,
      }),
    ).toMatchObject({ completionPercent: 20, canEnable: false });
    expect(evaluateReadiness(complete)).toMatchObject({
      completionPercent: 80,
      canEnable: true,
      status: 'DISABLED',
    });
    expect(evaluateReadiness({ ...complete, enabled: true })).toMatchObject({
      completionPercent: 100,
      status: 'ACTIVE',
    });
  });

  it('reports an enabled owner profile as DISABLED for a helmet not yet switched on', () => {
    expect(helmetProfileStatus('ACTIVE', 'ACTIVATED')).toBe('DISABLED');
    expect(helmetProfileStatus('ACTIVE', 'ACTIVE')).toBe('ACTIVE');
    expect(helmetProfileStatus('INCOMPLETE', 'ACTIVATED')).toBe('INCOMPLETE');
  });
});
