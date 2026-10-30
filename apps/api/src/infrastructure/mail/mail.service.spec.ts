import type { AppConfigService } from '../../config/app-config.service';
import { MailService } from './mail.service';

function service(env: Record<string, unknown>, production = true) {
  const config = {
    get: (k: string) => env[k],
    isProduction: production,
  } as unknown as AppConfigService;
  const mail = new MailService(config);
  mail.onModuleInit();
  return mail;
}

const message = { to: 'rider@example.com', subject: 'S', text: 'T', html: '<p>H</p>' };
const FROM = 'OZZO Safety ID <no-reply@ozzohelmets.cloud>';

describe('MailService (resend)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts the message to the Resend API with the key', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = fetchMock as unknown as typeof fetch;
    const mail = service({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: FROM });
    expect(mail.available).toBe(true);
    await mail.send(message);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer re_test');
    expect(JSON.parse(init.body as string)).toEqual({
      from: FROM,
      to: ['rider@example.com'],
      subject: 'S',
      text: 'T',
      html: '<p>H</p>',
    });
  });

  it('throws with the Resend error and without the recipient', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ name: 'validation_error', message: 'The domain is not verified.' }),
    }) as unknown as typeof fetch;
    const mail = service({ MAIL_TRANSPORT: 'resend', RESEND_API_KEY: 're_test', MAIL_FROM: FROM });
    const err = await mail.send(message).catch((e: Error) => e);
    expect((err as Error).message).toContain('HTTP 403');
    expect((err as Error).message).toContain('domain is not verified');
    expect((err as Error).message).not.toContain('rider@example.com');
  });

  it('is unavailable in production with the log transport', async () => {
    const mail = service({ MAIL_TRANSPORT: 'log', MAIL_FROM: FROM });
    expect(mail.available).toBe(false);
    await expect(mail.send(message)).rejects.toThrow('not configured');
  });
});
