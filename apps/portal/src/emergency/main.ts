/**
 * Public emergency page (/e/:token). Deliberately framework-free: one small module, no runtime
 * dependencies, DOM built only through textContent/attributes (never innerHTML with data), so it
 * loads fast on poor connections and owner-supplied text can never inject markup.
 */
import {
  buildEmergencySummaryText,
  mapsUrl,
  sceneMessage,
  sceneSteps,
  smsHref,
  whatsappHref,
  type PublicEmergencyContactDto,
  type PublicEmergencyDto,
  type PublicEmergencyProfileDto,
  type PublicProductVerificationDto,
} from '@helmet/types';
import './emergency.css';

const API_BASE: string = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';
const EMERGENCY_NUMBER: string = import.meta.env.VITE_EMERGENCY_NUMBER ?? '112';
const TOKEN_RE = /^[0-9A-Za-z]{22}$/;

type Lookup =
  | { kind: 'ok'; data: PublicEmergencyDto }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'error' };
type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

const tel = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

async function lookup(token: string): Promise<Lookup> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/public/emergency/${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (res.status === 404) return { kind: 'not-found' };
      if (res.status === 429) return { kind: 'rate-limited' };
      if (res.ok) {
        const body = (await res.json()) as { success: boolean; data: PublicEmergencyDto };
        if (body.success) return { kind: 'ok', data: body.data };
      }
    } catch {
      /* network error: retry */
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return { kind: 'error' };
}

function header(title: string, eyebrow = 'Safety ID', alert = false): HTMLElement {
  return h(
    'header',
    { class: alert ? 'top alert' : 'top' },
    h('p', { class: 'eyebrow' }, eyebrow),
    h('h1', {}, title),
  );
}

function messageCard(title: string, body: string, variant = ''): HTMLElement {
  return h(
    'section',
    { class: `card ${variant}`.trim(), role: 'status' },
    h('h2', {}, title),
    h('p', { class: 'lead' }, body),
  );
}

/** One labelled list inside the medical card (omitted when the owner shared nothing). */
function medGroup(title: string, items: string[] | undefined, extraClass = ''): HTMLElement | null {
  if (!items?.length) return null;
  return h(
    'div',
    { class: `med-group ${extraClass}`.trim() },
    h('h3', {}, title),
    h('ul', { class: 'list' }, ...items.map((i) => h('li', {}, i))),
  );
}

function profileView(data: PublicEmergencyDto): Node[] {
  const p: PublicEmergencyProfileDto = data.profile ?? {};
  const facts: string[] = [];
  if (p.age !== undefined) facts.push(`Age ${p.age}`);
  if (p.dateOfBirth) facts.push(`Born ${p.dateOfBirth}`);
  if (p.gender) facts.push(p.gender.charAt(0) + p.gender.slice(1).toLowerCase().replace(/_/g, ' '));
  if (p.organDonor !== undefined) facts.push(p.organDonor ? 'Organ donor' : 'Not an organ donor');

  const nodes: Child[] = [];
  // Who this is: name, photo and quick facts in one calm card.
  if (p.name || p.photoUrl || facts.length) {
    nodes.push(
      h(
        'section',
        { class: 'card person-card' },
        h(
          'div',
          { class: 'person' },
          p.photoUrl
            ? h('img', {
                class: 'photo',
                src: p.photoUrl,
                alt: p.name ? `Photo of ${p.name}` : 'Photo of the owner',
                width: '88',
                height: '88',
              })
            : null,
          h('div', {}, h('h3', {}, 'Name'), h('p', { class: 'name' }, p.name ?? 'Not shared')),
        ),
        facts.length
          ? h('div', { class: 'facts' }, ...facts.map((f) => h('span', { class: 'fact' }, f)))
          : null,
      ),
    );
  }
  // Same order as the server-rendered page: who, what to do, the Medical ID (blood group badge,
  // allergies first), who to call, notes. No product, model, batch or warranty at all.
  nodes.push(sceneCard());
  const medical = [
    medGroup('Allergies', p.allergies, 'allergy'),
    medGroup('Medical conditions', p.medicalConditions),
    medGroup('Medications', p.medications),
  ].filter((g): g is HTMLElement => g !== null);
  if (medical.length || p.bloodGroupLabel)
    nodes.push(
      h(
        'section',
        { class: 'card medical', 'aria-label': 'Medical information' },
        h(
          'div',
          { class: 'med-head' },
          h('h3', {}, 'Medical ID'),
          p.bloodGroupLabel
            ? h(
                'div',
                { class: 'blood-badge', 'aria-label': `Blood group ${p.bloodGroupLabel}` },
                h('span', {}, 'Blood'),
                h('strong', {}, p.bloodGroupLabel),
              )
            : null,
        ),
        ...medical,
      ),
    );
  if (data.contacts?.length) nodes.push(contactsCard(data.contacts, p.name));
  if (p.emergencyNotes)
    nodes.push(
      h(
        'section',
        { class: 'card' },
        h('h3', {}, 'Other notes'),
        h('p', { class: 'notes' }, p.emergencyNotes),
      ),
    );
  if (nodes.filter(Boolean).length === 1)
    nodes.push(
      messageCard('Emergency profile', 'The owner has chosen not to share details publicly.'),
    );
  nodes.push(h('p', { class: 'disclaimer' }, data.message));
  const summary = buildEmergencySummaryText(data);
  if (summary) nodes.push(summaryActions(summary));
  if (data.safetyId.code)
    nodes.push(h('p', { class: 'safety-id' }, 'Safety ID ', h('code', {}, data.safetyId.code)));
  return nodes.filter((n): n is Node => n instanceof Node);
}

/** Copy / print the approved information only (built from the public DTO, nothing hidden). */
function summaryActions(summary: string): HTMLElement {
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const copy = h(
    'button',
    { class: 'btn btn-secondary', type: 'button' },
    'Copy medical information',
  );
  copy.addEventListener('click', () => {
    const done = () => (status.textContent = 'Copied. Paste it into a message or note.');
    const fallback = () => {
      const area = h('textarea', { readonly: 'true', class: 'copy-fallback', rows: '8' });
      area.value = summary;
      status.replaceChildren('Select and copy the text below:', area);
      area.select();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(summary).then(done, fallback);
    else fallback();
  });
  const print = h(
    'button',
    { class: 'btn btn-secondary', type: 'button' },
    'Print emergency information',
  );
  print.addEventListener('click', () => window.print());
  return h(
    'section',
    { class: 'actions no-print', 'aria-label': 'Share this information' },
    copy,
    print,
    status,
  );
}

function sceneCard(): HTMLElement {
  return h(
    'section',
    { class: 'card scene', 'aria-labelledby': 'scene-h' },
    h('h3', { id: 'scene-h' }, 'What to do now'),
    h('ol', { class: 'steps' }, ...sceneSteps(EMERGENCY_NUMBER).map((s) => h('li', {}, s))),
  );
}

/**
 * "Tell {first} where you are": the links carry the message even if location is refused; on tap
 * the bystander's location is read in their browser only (never sent to us) and added as a map
 * link. Gives up on location after 8 s so the message always goes.
 */
function shareLocation(contact: PublicEmergencyContactDto, ownerName?: string): HTMLElement {
  const first = contact.name.split(' ')[0] || contact.name;
  const status = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const link = (kind: 'sms' | 'wa', label: string) => {
    const build = (url?: string) =>
      kind === 'sms'
        ? smsHref(contact.phone, sceneMessage(ownerName, url))
        : whatsappHref(contact.phone, sceneMessage(ownerName, url));
    const a = h('a', { class: 'btn btn-secondary', href: build() }, label);
    a.addEventListener('click', (e) => {
      if (!navigator.geolocation) return;
      e.preventDefault();
      status.textContent = 'Getting your location…';
      let done = false;
      const go = (p: GeolocationPosition | null) => {
        if (done) return;
        done = true;
        status.textContent = p
          ? 'Location added. Opening…'
          : 'No location (permission off). Sending the message without it…';
        location.href = build(p ? mapsUrl(p.coords.latitude, p.coords.longitude) : undefined);
      };
      setTimeout(() => go(null), 8000);
      navigator.geolocation.getCurrentPosition(go, () => go(null), {
        timeout: 8000,
        maximumAge: 60000,
      });
    });
    return a;
  };
  return h(
    'div',
    { class: 'share-loc no-print' },
    h('p', { class: 'muted' }, `Tell ${first} what happened and where you are:`),
    h(
      'div',
      { class: 'actions' },
      link('sms', 'SMS my location'),
      link('wa', 'WhatsApp my location'),
    ),
    status,
  );
}

function contactsCard(contacts: PublicEmergencyContactDto[], ownerName?: string): HTMLElement {
  return h(
    'section',
    { class: 'card strong', 'aria-labelledby': 'contacts-h' },
    h('h3', { id: 'contacts-h' }, contacts.length > 1 ? 'Emergency contacts' : 'Emergency contact'),
    h('p', { class: 'muted' }, 'Provided by the owner'),
    ...contacts.map((c, i) => {
      const first = c.name.split(' ')[0] || c.name;
      return h(
        'div',
        { class: 'contact' },
        h('p', { class: 'contact-name' }, c.name),
        h('p', { class: 'muted' }, c.relationship),
        h(
          'a',
          {
            class: `btn call-btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}`,
            href: tel(c.phone),
            'aria-label': `Call ${c.name} on ${c.phone}`,
          },
          h('span', {}, `Call ${first}`),
          h('span', { class: 'call-number' }, c.phone),
        ),
        c.alternatePhone
          ? h(
              'a',
              {
                class: 'btn btn-secondary call-btn',
                href: tel(c.alternatePhone),
                'aria-label': `Call ${c.name} on alternate number ${c.alternatePhone}`,
              },
              h('span', {}, 'Call alternate number'),
              h('span', { class: 'call-number' }, c.alternatePhone),
            )
          : null,
      );
    }),
    shareLocation(contacts[0]!, ownerName),
  );
}

const INACTIVE_TITLES: Record<'DAMAGED' | 'REPLACED' | 'DEACTIVATED' | 'RECALLED', string> = {
  DAMAGED: 'Marked as damaged',
  REPLACED: 'Replaced',
  DEACTIVATED: 'No longer active',
  RECALLED: 'Product recall',
};

function render(token: string, result: Lookup | null): void {
  const app = document.getElementById('app');
  if (!app) return;
  const main = h('main', { class: 'content' });
  let top = header('Emergency information');

  if (result === null) {
    main.append(
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'lead' }, 'Loading emergency information…'),
        h('div', { class: 'skeleton' }),
        h('div', { class: 'skeleton skeleton-short' }),
      ),
    );
  } else if (result.kind === 'ok') {
    const d = result.data;
    switch (d.state) {
      case 'ACTIVE':
        top = header('Emergency information', 'Safety ID · Emergency');
        main.append(...profileView(d));
        break;
      case 'NOT_ACTIVATED':
        main.append(
          h(
            'section',
            { class: 'card strong' },
            h('h2', {}, 'Safety ID not activated'),
            h('p', { class: 'lead' }, d.message),
            h(
              'p',
              { class: 'muted' },
              'Ready to activate. You’ll need the Activation PIN printed with this Safety ID.',
            ),
            h(
              'a',
              {
                class: 'btn btn-cta mt-20',
                href: `/activate?t=${encodeURIComponent(token)}`,
              },
              'Activate Safety ID',
            ),
          ),
        );
        break;
      case 'LOST':
      case 'STOLEN':
        top = header(d.state === 'LOST' ? 'Reported lost' : 'Reported stolen', 'Safety ID', true);
        main.append(
          messageCard(
            d.state === 'LOST' ? 'Reported lost' : 'Reported stolen',
            d.message,
            'danger',
          ),
        );
        break;
      case 'DAMAGED':
      case 'RECALLED':
      case 'REPLACED':
      case 'DEACTIVATED': {
        const title = INACTIVE_TITLES[d.state];
        top = header(title, d.profile ? 'Safety ID · Emergency' : 'Safety ID', true);
        if (d.profile) {
          // Phase 4: a damaged/recalled linked helmet that was already sharing keeps the approved
          // information, with the lifecycle warning shown first.
          main.append(messageCard(title, d.warning ?? d.message, 'danger'), ...profileView(d));
        } else {
          // Lifecycle notices without a profile never carry personal or medical information.
          main.append(messageCard(title, d.message));
        }
        break;
      }
      default:
        main.append(messageCard('Safety ID', d.message));
    }
  } else if (result.kind === 'not-found') {
    main.append(
      messageCard(
        'We could not find this Safety ID',
        'This QR code is not in the registry. It may be damaged or mistyped. In an emergency, call the number below.',
      ),
      sceneCard(),
    );
  } else if (result.kind === 'rate-limited') {
    main.append(
      messageCard(
        'Please wait a moment',
        'Too many requests from this network. Try again in a minute. In an emergency, call the number below.',
      ),
    );
  } else {
    const retry = h('button', { class: 'btn btn-secondary mt-16', type: 'button' }, 'Try again');
    retry.addEventListener('click', () => void start(token));
    main.append(
      h(
        'section',
        { class: 'card', role: 'alert' },
        h('h2', {}, 'Couldn’t load information'),
        h(
          'p',
          { class: 'lead' },
          'This may be a temporary problem. Check your connection and try again. In an emergency, call the number below.',
        ),
        retry,
      ),
      sceneCard(),
    );
  }
  // "View product information" only when a product is linked (standalone Safety IDs have none).
  if (result?.kind === 'ok' && result.data.linkedProduct) main.append(verifyLink(token));
  app.replaceChildren(top, main);
}

/** Same QR, second purpose: product identity of the linked helmet (no personal data). */
function verifyLink(token: string): HTMLElement {
  return h(
    'p',
    { class: 'muted no-print verify-link' },
    h('a', { href: `/verify/${encodeURIComponent(token)}` }, 'View product information'),
  );
}

// ───────────── /verify/:token ─────────────

const REPORT_REASONS: [string, string][] = [
  ['QR_COPIED', 'QR appears copied'],
  ['DETAILS_MISMATCH', 'Helmet details do not match'],
  ['LOOKS_COUNTERFEIT', 'Product looks counterfeit'],
  ['ID_DAMAGED', 'Helmet ID damaged'],
  ['OTHER', 'Other'],
];

const monthFmt = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });

function warrantyText(w: NonNullable<PublicProductVerificationDto['warranty']>): string {
  const end = w.endsOn ? dayFmt.format(new Date(`${w.endsOn}T00:00:00Z`)) : '';
  switch (w.status) {
    case 'ACTIVE':
      return `Active until ${end}`;
    case 'EXPIRED':
      return `Expired on ${end}`;
    case 'NOT_REGISTERED':
      return 'Not registered';
    case 'REPLACED':
      return 'Moved to a replacement helmet';
    default:
      return 'Not active';
  }
}

function fact(label: string, value: string, mono = false): HTMLElement {
  return h(
    'div',
    { class: 'fact' },
    h('p', { class: 'muted' }, label),
    h('p', mono ? { class: 'mono' } : {}, value),
  );
}

function reportForm(token: string): HTMLElement {
  const status = h('p', { class: 'muted', role: 'status' });
  const select = h('select', { id: 'report-reason', name: 'reason', required: 'true' });
  for (const [value, label] of REPORT_REASONS) select.append(h('option', { value }, label));
  const text = h('textarea', { id: 'report-description', maxlength: '1000', rows: '3' });
  const email = h('input', {
    id: 'report-email',
    type: 'email',
    maxlength: '254',
    autocomplete: 'email',
  });
  const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Send report');
  const form = h(
    'form',
    { class: 'card', id: 'report-form', hidden: 'true' },
    h('h3', {}, 'Report a problem with this product'),
    h('label', { for: 'report-reason' }, 'What is wrong?'),
    select,
    h('label', { for: 'report-description' }, 'Details (optional)'),
    text,
    h('label', { for: 'report-email' }, 'Email, if you want us to contact you (optional)'),
    email,
    submit,
    status,
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit.setAttribute('disabled', 'true');
    void fetch(`${API_BASE}/public/product-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        publicToken: TOKEN_RE.test(token) ? token : undefined,
        reason: (select as HTMLSelectElement).value,
        description: (text as HTMLTextAreaElement).value.trim() || undefined,
        contactEmail: (email as HTMLInputElement).value.trim() || undefined,
      }),
    })
      .then((res) => {
        if (res.ok) {
          form.replaceChildren(
            h('h3', {}, 'Thank you'),
            h('p', { class: 'lead' }, 'Your report has been received and will be reviewed.'),
          );
          return;
        }
        status.textContent =
          res.status === 429
            ? 'Too many reports from this network. Please try again later.'
            : 'Please check the form and try again.';
        submit.removeAttribute('disabled');
      })
      .catch(() => {
        status.textContent = 'Check your connection and try again.';
        submit.removeAttribute('disabled');
      });
  });
  return form;
}

function reportButton(form: HTMLElement): HTMLElement {
  const btn = h(
    'button',
    { class: 'btn btn-secondary', type: 'button' },
    'Report a problem with this product',
  );
  btn.addEventListener('click', () => {
    form.removeAttribute('hidden');
    btn.remove();
    form.querySelector('select')?.focus();
  });
  return btn;
}

async function verifyLookup(token: string): Promise<PublicProductVerificationDto | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/public/verify/${encodeURIComponent(token)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (res.ok) return ((await res.json()) as { data: PublicProductVerificationDto }).data;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  return null;
}

function renderVerify(token: string, d: PublicProductVerificationDto | null | 'loading'): void {
  const app = document.getElementById('app');
  if (!app) return;
  const main = h('main', { class: 'content' });
  const top = header('Verification', 'Safety ID');
  if (d === 'loading') {
    main.append(
      h(
        'section',
        { class: 'card' },
        h('p', { class: 'lead' }, 'Checking…'),
        h('div', { class: 'skeleton' }),
      ),
    );
  } else if (d === null) {
    main.append(
      messageCard('Couldn’t check this Safety ID', 'Check your connection and try again.'),
    );
  } else {
    const form = reportForm(token);
    if (d.state === 'VERIFIED' && d.product) {
      const p = d.product;
      main.append(
        h(
          'section',
          { class: 'card strong verified' },
          h('p', { class: 'verified-mark' }, '✓ Product identity verified'),
          h('h2', {}, `${p.brand} ${p.modelName}`),
          h(
            'div',
            { class: 'facts' },
            fact('Helmet ID', p.helmetCode, true),
            fact('SKU', p.sku, true),
            fact('Manufactured', monthFmt.format(new Date(`${p.manufactured}-01T00:00:00Z`))),
            fact('Batch', p.batchRef, true),
            fact('Status', d.lifecycle?.label ?? '—'),
            d.warranty ? fact('Warranty', warrantyText(d.warranty)) : null,
            d.safetyId ? fact('Safety ID', d.safetyId.code, true) : null,
          ),
        ),
      );
      if (d.recallWarning) main.append(messageCard('Recall notice', d.recallWarning, 'danger'));
      // Set by an admin decision only (QR integrity); neutral wording, never "counterfeit".
      if (d.integrityNotice) main.append(messageCard('Please contact support', d.integrityNotice));
      if (d.lifecycle?.warning)
        main.append(messageCard(d.lifecycle.label, d.lifecycle.warning, 'danger'));
      main.append(
        h('p', { class: 'disclaimer' }, d.message),
        h(
          'a',
          { class: 'btn btn-primary', href: `/e/${encodeURIComponent(token)}` },
          'Emergency information',
        ),
      );
    } else if (d.state === 'SAFETY_ID_VERIFIED') {
      // Phase 9: a standalone Safety ID — registered, but no product facts exist.
      main.append(
        h(
          'section',
          { class: 'card strong verified' },
          h('p', { class: 'verified-mark' }, '✓ Safety ID verified'),
          h('p', { class: 'lead' }, 'This Safety ID is registered with Ozzo.'),
          h('p', {}, 'No registered product is currently linked to this Safety ID.'),
          h(
            'div',
            { class: 'facts' },
            d.safetyId ? fact('Safety ID', d.safetyId.code, true) : null,
          ),
        ),
      );
      if (d.integrityNotice) main.append(messageCard('Please contact support', d.integrityNotice));
      main.append(
        h(
          'a',
          { class: 'btn btn-primary', href: `/e/${encodeURIComponent(token)}` },
          'Emergency information',
        ),
      );
    } else {
      main.append(
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'We could not verify this Safety ID'),
          h('p', { class: 'lead' }, 'Check the QR code or contact support.'),
        ),
      );
    }
    main.append(reportButton(form), form);
  }
  app.replaceChildren(top, main);
}

async function startVerify(token: string): Promise<void> {
  renderVerify(token, 'loading');
  renderVerify(token, await verifyLookup(token));
}

async function start(token: string): Promise<void> {
  render(token, null);
  render(token, TOKEN_RE.test(token) ? await lookup(token) : { kind: 'not-found' });
}

const call = document.getElementById('call-emergency');
if (call) {
  call.setAttribute('href', tel(EMERGENCY_NUMBER));
  call.setAttribute('aria-label', `Call emergency services on ${EMERGENCY_NUMBER}`);
  call.textContent = `Call emergency ${EMERGENCY_NUMBER}`;
}
const path = location.pathname.replace(/\/$/, '');
if (path.startsWith('/verify/'))
  void startVerify(decodeURIComponent(path.slice('/verify/'.length)));
else void start(decodeURIComponent(path.replace(/^\/e\//, '')));
