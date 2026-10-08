import { decodeAnyCursor, decodeCursor, encodeCursor } from './cursor';
import { deviceCategory } from './device';

const id = '0b9f1c2e-1111-4a2b-9c3d-123456789abc';

describe('cursor', () => {
  it('round-trips time and score cursors', () => {
    const t = new Date('2026-10-01T10:00:00Z').toISOString();
    expect(decodeCursor(encodeCursor({ t, id }))).toEqual({ t, id });
    expect(decodeAnyCursor(encodeCursor({ s: 42, id }))).toEqual({ s: 42, id });
  });

  it('rejects tampered or malformed cursors instead of throwing', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(encodeCursor({ t: 'yesterday', id }))).toBeNull();
    expect(decodeAnyCursor(encodeCursor({ s: 1, id: "1' OR 1=1" }))).toBeNull();
    expect(decodeAnyCursor('x'.repeat(201))).toBeNull();
    expect(decodeAnyCursor(undefined)).toBeNull();
  });
});

describe('deviceCategory (coarse, no fingerprinting)', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'MOBILE',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'MOBILE',
    ],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'TABLET'],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'TABLET',
    ],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120', 'DESKTOP'],
    ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'BOT'],
    ['WhatsApp/2.23.20.0', 'BOT'],
    ['curl/8.4.0', 'BOT'],
    ['SomethingElse/1.0', 'OTHER'],
  ])('%s → %s', (ua, expected) => {
    expect(deviceCategory(ua)).toBe(expected);
  });

  it('returns null without a user agent', () => {
    expect(deviceCategory(null)).toBeNull();
    expect(deviceCategory('')).toBeNull();
  });
});
