import { Writable } from 'node:stream';
import pino from 'pino';
import { REDACT_PATHS, safeLogUrl } from './logging.module';

/** Runs real pino with the production redaction list and checks nothing sensitive is emitted. */
function capture(obj: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink).info(obj, 'test');
  return out;
}

describe('log redaction audit', () => {
  it.each([
    ['password', { body: { password: 'Hunter2-Secret!' } }, 'Hunter2-Secret!'],
    ['activation PIN', { body: { pin: 'ABCD2345' } }, 'ABCD2345'],
    ['recovery code', { body: { recoveryCode: 'RK-AAAA-BBBB' } }, 'RK-AAAA-BBBB'],
    ['recovery grant credential', { result: { credential: 'AR-SECRET-GRANT' } }, 'AR-SECRET-GRANT'],
    ['reset token', { body: { resetToken: 'reset-tok-123' } }, 'reset-tok-123'],
    ['transfer code', { body: { transferCode: 'TX-9999' } }, 'TX-9999'],
    ['access token', { data: { accessToken: 'eyJhbGciOi.jwt' } }, 'eyJhbGciOi.jwt'],
    ['refresh token', { data: { refreshToken: 'refresh-abc' } }, 'refresh-abc'],
    ['recent-auth token', { data: { recentAuthToken: 'ra-abc' } }, 'ra-abc'],
    [
      'authorization header',
      { req: { headers: { authorization: 'Bearer eyJsecret' } } },
      'eyJsecret',
    ],
    ['cookie header', { req: { headers: { cookie: 'helmet_rt=abc' } } }, 'helmet_rt=abc'],
    ['x-recent-auth header', { req: { headers: { 'x-recent-auth': 'ra-header' } } }, 'ra-header'],
    ['set-cookie', { res: { headers: { 'set-cookie': 'helmet_rt=zzz' } } }, 'helmet_rt=zzz'],
    ['allergies', { profile: { allergies: ['Penicillin'] } }, 'Penicillin'],
    ['medical conditions', { profile: { medicalConditions: ['Epilepsy'] } }, 'Epilepsy'],
    ['medications', { profile: { medications: ['Insulin'] } }, 'Insulin'],
    ['emergency notes', { profile: { emergencyNotes: 'Pacemaker fitted' } }, 'Pacemaker'],
    ['blood group', { profile: { bloodGroup: 'AB_NEGATIVE' } }, 'AB_NEGATIVE'],
    ['date of birth', { profile: { dateOfBirth: '1990-01-02' } }, '1990-01-02'],
    ['contact phone', { contact: { phone: '+919812345678' } }, '+919812345678'],
    ['PIN escrow ciphertext', { row: { pinCiphertext: 'v1.abc.def.ghi' } }, 'v1.abc.def.ghi'],
  ])('redacts %s', (_label, obj, secret) => {
    const line = capture(obj);
    expect(line).not.toContain(secret);
    expect(line).toContain('[REDACTED]');
  });

  it('masks QR tokens in request paths and drops query strings', () => {
    expect(safeLogUrl('/api/v1/public/emergency/AbCdEfGhIjKlMnOpQrStUv')).toBe(
      '/api/v1/public/emergency/:token',
    );
    expect(safeLogUrl('/api/v1/public/emergency/AbCdEfGhIjKlMnOpQrStUv/photo')).toBe(
      '/api/v1/public/emergency/:token/photo',
    );
    expect(safeLogUrl('/api/v1/public/verify/AbCdEfGhIjKlMnOpQrStUv')).toBe(
      '/api/v1/public/verify/:token',
    );
    expect(safeLogUrl('/e/AbCdEfGhIjKlMnOpQrStUv')).toBe('/e/:token');
    expect(safeLogUrl('/api/v1/customer/helmets?token=secret&x=1')).toBe(
      '/api/v1/customer/helmets',
    );
  });
});
