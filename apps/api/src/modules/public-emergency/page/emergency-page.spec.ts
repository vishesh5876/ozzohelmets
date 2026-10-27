import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PublicHelmetState, type PublicEmergencyDto } from '@helmet/types';
import { EMERGENCY_PAGE_CSP, renderEmergencyPage } from './emergency-page';

const opts = { token: 'Tok_en-123', emergencyNumber: '112' };

const active = (over: Partial<PublicEmergencyDto> = {}): PublicEmergencyDto => ({
  state: PublicHelmetState.ACTIVE,
  safetyId: { code: 'SI-7958-72SA' },
  linkedProduct: false,
  message: 'Information provided by the owner.',
  profile: {
    name: 'Meera Rao',
    bloodGroupLabel: 'O+',
    allergies: ['Penicillin'],
    medications: ['Insulin'],
    medicalConditions: ['Diabetes'],
    emergencyNotes: 'Wears contact lenses',
  },
  contacts: [{ name: 'Arun Rao', relationship: 'Brother', phone: '+91 98765 43210' }],
  ...over,
});

const render = (data: PublicEmergencyDto) => renderEmergencyPage({ kind: 'ok', data }, opts);

describe('renderEmergencyPage (server-rendered /e/:token)', () => {
  it('renders the whole profile in one document with the emergency call bar', () => {
    const { status, html } = render(active());
    expect(status).toBe(200);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    for (const text of ['Meera Rao', 'O+', 'Penicillin', 'Insulin', 'Diabetes', 'Arun Rao'])
      expect(html).toContain(text);
    expect(html).toContain('href="tel:+919876543210"');
    expect(html).toContain('href="tel:112"');
    expect(html).toContain('<code>SI-7958-72SA</code>');
    // No external requests at all: stylesheet inline, data: favicon, no src= scripts or images.
    // (Links a person taps, like WhatsApp or a map, are navigation, not page loads.)
    expect(html).not.toMatch(/<link[^>]+stylesheet|<script[^>]+src=|src="https?:|url\(https?:/);
  });

  it('escapes every owner-supplied string', () => {
    const evil = '<img src=x onerror=alert(1)>"\'&';
    const { html } = render(
      active({
        profile: { name: evil, emergencyNotes: evil, allergies: [evil] },
        contacts: [{ name: evil, relationship: evil, phone: '"><script>' }],
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');
  });

  it('only adds the copy / print script when a profile is shown, and its hash is in the CSP', () => {
    const { html } = render(active());
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');
    expect(EMERGENCY_PAGE_CSP).toContain(`script-src 'sha256-${sha(script)}'`);
    expect(EMERGENCY_PAGE_CSP).toContain(`style-src 'sha256-${sha(style)}'`);
    expect(EMERGENCY_PAGE_CSP).not.toContain('unsafe-inline');
    // Actions start hidden so the page is correct without JavaScript.
    expect(html).toContain('id="share-actions" aria-label="Share this information" hidden');
    expect(renderEmergencyPage({ kind: 'not-found' }, opts).html).not.toContain('<script>');
  });

  it('offers activation for an unactivated Safety ID', () => {
    const { html } = render({
      state: PublicHelmetState.NOT_ACTIVATED,
      safetyId: {},
      linkedProduct: true,
      message: 'This Safety ID has not been activated yet.',
    });
    expect(html).toContain('href="/activate?t=Tok_en-123"');
    expect(html).toContain('href="/verify/Tok_en-123"');
    expect(html).not.toContain('Meera');
  });

  it('shows lost / stolen as alerts with no personal data', () => {
    for (const state of [PublicHelmetState.LOST, PublicHelmetState.STOLEN]) {
      const { html } = render({ ...active(), state, profile: null, contacts: [] });
      expect(html).toContain('class="top alert"');
      expect(html).toContain('class="card danger"');
      expect(html).not.toContain('Arun');
    }
  });

  it('keeps the approved profile under the warning for a damaged helmet', () => {
    const { html } = render(active({ state: PublicHelmetState.DAMAGED, warning: 'Damaged.' }));
    expect(html.indexOf('Damaged.')).toBeLessThan(html.indexOf('Meera Rao'));
  });

  it.each([
    ['not-found', 404, 'We could not find this Safety ID'],
    ['rate-limited', 429, 'Please wait a moment'],
    ['error', 503, 'Try again'],
  ] as const)('%s → %i, still with the emergency call button', (kind, status, text) => {
    const page = renderEmergencyPage({ kind }, opts);
    expect(page.status).toBe(status);
    expect(page.html).toContain(text);
    expect(page.html).toContain('id="call-emergency"');
  });

  it('Medical ID: blood group badge, allergies listed first; bystander steps on the page', () => {
    const { html } = render(active());
    expect(html).toContain('<div class="blood-badge" aria-label="Blood group O+">');
    expect(html.indexOf('Allergies')).toBeLessThan(html.indexOf('Medical conditions'));
    expect(html).toContain('What to do now');
    expect(html).toContain('Do not remove the helmet unless they are not breathing.');
    expect(html).toContain('Call 112 now');
    // Steps also when the QR is unknown or the lookup failed: an emergency may still be on.
    expect(renderEmergencyPage({ kind: 'not-found' }, opts).html).toContain('What to do now');
    expect(renderEmergencyPage({ kind: 'error' }, opts).html).toContain('What to do now');
    // Not for an owner who is just activating, or for a stolen helmet.
    expect(
      render({ ...active(), state: PublicHelmetState.NOT_ACTIVATED, profile: null }).html,
    ).not.toContain('What to do now');
  });

  it('send location: SMS and WhatsApp to the first contact, working without JavaScript', () => {
    const { html } = render(active());
    const msg = encodeURIComponent(
      "EMERGENCY: I'm with Meera Rao (scanned their OZZO Safety ID). Please call me back.",
    );
    // Without JS the links already open the message (no location); JS only adds the map link.
    expect(html).toContain(`href="sms:+919876543210?&amp;body=${msg.replace(/'/g, '&#39;')}"`);
    expect(html).toContain(`href="https://wa.me/919876543210?text=${msg.replace(/'/g, '&#39;')}"`);
    expect(html).toContain('data-loc="sms" data-to="+919876543210"');
    expect(html).toContain('id="loc-status"');
    // Owner name not shared: no name in the message.
    const anon = render(active({ profile: { allergies: ['Latex'] } })).html;
    expect(anon).toContain('the rider whose Safety ID I scanned');
    // No contacts, no location block.
    expect(render(active({ contacts: [] })).html).not.toContain('data-loc=');
  });

  it('stays small enough for the first network round trip', () => {
    expect(Buffer.byteLength(render(active()).html)).toBeLessThan(14_000);
  });

  it('inlines the same stylesheet as the portal (no drift)', () => {
    const root = resolve(__dirname, '../../../../../..');
    expect(() =>
      execFileSync('node', ['scripts/sync-emergency-css.mjs', '--check'], { cwd: root }),
    ).not.toThrow();
  });
});
