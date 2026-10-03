/**
 * Public emergency page (/e/:token). Deliberately framework-free: one small module, no runtime
 * dependencies, DOM built only through textContent/attributes (never innerHTML with data), so it
 * loads fast on poor connections and owner-supplied text can never inject markup.
 */
import type {
  PublicEmergencyContactDto,
  PublicEmergencyDto,
  PublicEmergencyProfileDto,
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

function header(title: string, eyebrow = 'Helmet ID', alert = false): HTMLElement {
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

function listCard(title: string, items: string[] | undefined, extraClass = ''): HTMLElement | null {
  if (!items?.length) return null;
  return h(
    'section',
    { class: `card ${extraClass}`.trim() },
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
  if (p.name || p.photoUrl || facts.length) {
    nodes.push(
      h(
        'section',
        { class: 'card strong' },
        h(
          'div',
          { class: 'person' },
          p.photoUrl
            ? h('img', {
                class: 'photo',
                src: p.photoUrl,
                alt: p.name ? `Photo of ${p.name}` : 'Photo of the helmet owner',
                width: '96',
                height: '96',
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
  if (p.bloodGroupLabel)
    nodes.push(
      h(
        'section',
        { class: 'card' },
        h('h3', {}, 'Blood group'),
        h('div', { class: 'blood' }, h('strong', {}, p.bloodGroupLabel)),
      ),
    );
  nodes.push(listCard('Allergies', p.allergies, 'allergy'));
  nodes.push(listCard('Medical conditions', p.medicalConditions));
  nodes.push(listCard('Medications', p.medications));
  if (p.emergencyNotes)
    nodes.push(
      h(
        'section',
        { class: 'card' },
        h('h3', {}, 'Emergency notes'),
        h('p', { class: 'notes' }, p.emergencyNotes),
      ),
    );
  if (data.contacts?.length) nodes.push(contactsCard(data.contacts));
  if (nodes.every((n) => !n))
    nodes.push(
      messageCard('Emergency profile', 'The owner has chosen not to share details publicly.'),
    );
  nodes.push(
    h(
      'p',
      { class: 'helmet' },
      `${data.helmet.brand} ${data.helmet.modelName}`,
      data.helmet.helmetCode ? ' · ' : '',
      data.helmet.helmetCode ? h('code', {}, data.helmet.helmetCode) : null,
    ),
    h('p', { class: 'disclaimer' }, data.message),
  );
  return nodes.filter((n): n is Node => n instanceof Node);
}

function contactsCard(contacts: PublicEmergencyContactDto[]): HTMLElement {
  return h(
    'section',
    { class: 'card strong' },
    h('h3', {}, 'Emergency contacts'),
    ...contacts.map((c, i) =>
      h(
        'div',
        { class: 'contact' },
        h('p', { class: 'contact-name' }, c.name),
        h('p', { class: 'muted' }, c.relationship),
        h(
          'a',
          { class: i === 0 ? 'btn btn-primary' : 'btn btn-secondary', href: tel(c.phone) },
          `Call ${c.name.split(' ')[0] ?? c.name}`,
        ),
        c.alternatePhone
          ? h(
              'a',
              { class: 'btn btn-secondary', href: tel(c.alternatePhone) },
              `Call alternate number`,
            )
          : null,
      ),
    ),
  );
}

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
        h('div', { class: 'skeleton', style: 'width:60%' }),
      ),
    );
  } else if (result.kind === 'ok') {
    const d = result.data;
    switch (d.state) {
      case 'ACTIVE':
        top = header('Emergency profile', 'Helmet ID · Emergency');
        main.append(...profileView(d));
        break;
      case 'NOT_ACTIVATED':
        main.append(
          h(
            'section',
            { class: 'card strong' },
            h('p', { class: 'muted' }, `${d.helmet.brand} ${d.helmet.modelName}`),
            h('h2', {}, 'Helmet not activated'),
            h('p', { class: 'lead' }, d.message),
            h(
              'a',
              {
                class: 'btn btn-primary',
                href: `/activate?t=${encodeURIComponent(token)}`,
                style: 'margin-top:20px',
              },
              'Activate helmet',
            ),
          ),
        );
        break;
      case 'LOST':
      case 'STOLEN':
        top = header(d.state === 'LOST' ? 'Reported lost' : 'Reported stolen', 'Helmet ID', true);
        main.append(
          messageCard(
            d.state === 'LOST' ? 'Reported lost' : 'Reported stolen',
            d.message,
            'danger',
          ),
        );
        break;
      default:
        main.append(messageCard(`${d.helmet.brand} ${d.helmet.modelName}`, d.message));
    }
  } else if (result.kind === 'not-found') {
    main.append(
      messageCard(
        'QR code not recognised',
        'This code is not registered with Helmet ID. If this helmet carries our label, it may not be genuine.',
      ),
    );
  } else if (result.kind === 'rate-limited') {
    main.append(
      messageCard(
        'Please wait a moment',
        'Too many requests from this network. Try again in a minute.',
      ),
    );
  } else {
    const retry = h(
      'button',
      { class: 'btn btn-secondary', type: 'button', style: 'margin-top:16px' },
      'Try again',
    );
    retry.addEventListener('click', () => void start(token));
    main.append(
      h(
        'section',
        { class: 'card', role: 'alert' },
        h('h2', {}, 'Couldn’t load information'),
        h('p', { class: 'lead' }, 'Check your connection and try again.'),
        retry,
      ),
    );
  }
  app.replaceChildren(top, main);
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
void start(decodeURIComponent(location.pathname.replace(/^\/e\//, '').replace(/\/$/, '')));
