import { normalizePhone } from './phone';

describe('normalizePhone', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['098765 43210', '+919876543210'],
    ['+91 98765-43210', '+919876543210'],
    ['(+91) 98765 43210', '+919876543210'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s → %s', (input, expected) => {
    expect(normalizePhone(input, 'IN')).toBe(expected);
  });

  it.each([
    '',
    '123',
    'abc',
    '+91 12345',
    '98765432101234567',
    '9876543210; drop table',
    '+1 (555) 000-0000',
  ])('rejects %p', (input) => {
    expect(normalizePhone(input, 'IN')).toBeNull();
  });

  it('uses the default region only for numbers without a country code', () => {
    expect(normalizePhone('020 7946 0958', 'GB')).toBe('+442079460958');
    expect(normalizePhone('+919876543210', 'GB')).toBe('+919876543210');
  });
});
