import { createHash } from 'node:crypto';
import {
  buildEmergencySummaryText,
  sceneMessage,
  sceneSteps,
  smsHref,
  whatsappHref,
  type PublicEmergencyContactDto,
  type PublicEmergencyDto,
  type PublicEmergencyProfileDto,
} from '@helmet/types';
import { EMERGENCY_PAGE_CSS } from './emergency-css.generated';

/**
 * Server-rendered public emergency page (/e/:token).
 *
 * Why: a bystander scanning a QR on a crash scene may have one bar of 2G. The client-rendered
 * page needed HTML → CSS + JS → API call → render: three sequential round trips after the
 * connection, and nothing without JavaScript. This page is ONE response (~3 KB gzipped) with the
 * person's information, the stylesheet inlined and no render-blocking request. It works with
 * JavaScript disabled; a tiny inline script only adds Copy / Print.
 *
 * Markup, wording and order mirror apps/portal/src/emergency/main.ts (which remains the fallback
 * when the API is unreachable, and serves /verify). Every owner-supplied string is HTML-escaped.
 */

export type EmergencyPageResult =
  | { kind: 'ok'; data: PublicEmergencyDto }
  | { kind: 'not-found' }
  | { kind: 'rate-limited' }
  | { kind: 'error' };

export interface EmergencyPageOptions {
  token: string;
  emergencyNumber: string;
}

const esc = (v: string): string =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const tel = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;

/**
 * Progressive enhancement only; the information never depends on it.
 * 1. Copy / print: reveals the actions.
 * 2. Send location: the SMS / WhatsApp links already carry the message; on tap the script asks
 *    for the bystander's location (in their browser only, nothing is sent to us) and adds a map
 *    link. Denied, unavailable or slow (8 s) → the message goes without it.
 */
const PAGE_SCRIPT =
  "(function(){var d=document,t=d.getElementById('summary-text'),a=d.getElementById('share-actions');" +
  "if(t&&a){var txt=(t.content||t).textContent;a.hidden=false;var s=d.getElementById('share-status');" +
  "var fb=function(){var x=d.createElement('textarea');x.readOnly=true;x.className='copy-fallback';x.rows=8;" +
  "x.value=txt;s.textContent='Select and copy the text below:';s.appendChild(x);x.select();};" +
  "d.getElementById('copy-summary').onclick=function(){var c=navigator.clipboard;" +
  "if(c&&c.writeText)c.writeText(txt).then(function(){s.textContent='Copied. Paste it into a message or note.';},fb);" +
  'else fb();};' +
  "d.getElementById('print-page').onclick=function(){window.print();};}" +
  "var ls=d.getElementById('loc-status'),g=navigator.geolocation,L=d.querySelectorAll('a[data-loc]');" +
  'if(!ls||!g)return;' +
  'for(var i=0;i<L.length;i++)L[i].onclick=function(e){var el=this,done=false;e.preventDefault();' +
  "ls.textContent='Getting your location\u2026';" +
  "var go=function(p){if(done)return;done=true;var m=el.getAttribute('data-msg');" +
  "if(p)m+=' Location: https://maps.google.com/?q='+p.coords.latitude.toFixed(6)+','+p.coords.longitude.toFixed(6);" +
  "ls.textContent=p?'Location added. Opening\u2026':'No location (permission off). Sending the message without it\u2026';" +
  "var to=el.getAttribute('data-to');location.href=el.getAttribute('data-loc')==='wa'?" +
  "'https://wa.me/'+to.replace(/^\\+/,'')+'?text='+encodeURIComponent(m):'sms:'+to+'?&body='+encodeURIComponent(m);};" +
  'setTimeout(function(){go(null);},8000);' +
  'g.getCurrentPosition(go,function(){go(null);},{timeout:8000,maximumAge:60000});};})();';

const sha = (s: string) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;

/**
 * Strict CSP: no external anything; the one inline stylesheet and script are allowed by hash
 * (no 'unsafe-inline'). Images only from this origin (the owner photo) or data: (favicon).
 */
export const EMERGENCY_PAGE_CSP = [
  "default-src 'none'",
  `style-src ${sha(EMERGENCY_PAGE_CSS)}`,
  `script-src ${sha(PAGE_SCRIPT)}`,
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function header(title: string, eyebrow = 'Safety ID', alert = false): string {
  return `<header class="${alert ? 'top alert' : 'top'}"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1></header>`;
}

function messageCard(title: string, body: string, variant = ''): string {
  return `<section class="${esc(`card ${variant}`.trim())}" role="status"><h2>${esc(title)}</h2><p class="lead">${esc(body)}</p></section>`;
}

function medGroup(title: string, items: string[] | undefined, extraClass = ''): string {
  if (!items?.length) return '';
  return `<div class="${esc(`med-group ${extraClass}`.trim())}"><h3>${esc(title)}</h3><ul class="list">${items
    .map((i) => `<li>${esc(i)}</li>`)
    .join('')}</ul></div>`;
}

function sceneCard(emergencyNumber: string): string {
  return (
    `<section class="card scene" aria-labelledby="scene-h"><h3 id="scene-h">What to do now</h3><ol class="steps">` +
    sceneSteps(emergencyNumber)
      .map((s) => `<li>${esc(s)}</li>`)
      .join('') +
    '</ol></section>'
  );
}

/** "Tell {first} where you are": SMS / WhatsApp links with the message; JS adds the location. */
function shareLocation(contact: PublicEmergencyContactDto, ownerName: string | undefined): string {
  const first = contact.name.split(' ')[0] || contact.name;
  const msg = sceneMessage(ownerName);
  const to = contact.phone.replace(/[^\d+]/g, '');
  const link = (kind: 'sms' | 'wa', href: string, label: string) =>
    `<a class="btn btn-secondary" href="${esc(href)}" data-loc="${kind}" data-to="${esc(to)}" data-msg="${esc(msg)}">${esc(label)}</a>`;
  return (
    `<div class="share-loc no-print"><p class="muted">${esc(`Tell ${first} what happened and where you are:`)}</p>` +
    `<div class="actions">${link('sms', smsHref(contact.phone, msg), 'SMS my location')}${link('wa', whatsappHref(contact.phone, msg), 'WhatsApp my location')}</div>` +
    '<p class="muted" role="status" aria-live="polite" id="loc-status"></p></div>'
  );
}

function contactsCard(contacts: PublicEmergencyContactDto[], ownerName?: string): string {
  const rows = contacts
    .map((c, i) => {
      const first = c.name.split(' ')[0] || c.name;
      const alt = c.alternatePhone
        ? `<a class="btn btn-secondary call-btn" href="${esc(tel(c.alternatePhone))}" aria-label="${esc(`Call ${c.name} on alternate number ${c.alternatePhone}`)}"><span>Call alternate number</span><span class="call-number">${esc(c.alternatePhone)}</span></a>`
        : '';
      return (
        `<div class="contact"><p class="contact-name">${esc(c.name)}</p><p class="muted">${esc(c.relationship)}</p>` +
        `<a class="btn call-btn ${i === 0 ? 'btn-primary' : 'btn-secondary'}" href="${esc(tel(c.phone))}" aria-label="${esc(`Call ${c.name} on ${c.phone}`)}"><span>${esc(`Call ${first}`)}</span><span class="call-number">${esc(c.phone)}</span></a>${alt}</div>`
      );
    })
    .join('');
  return (
    `<section class="card strong" aria-labelledby="contacts-h"><h3 id="contacts-h">${contacts.length > 1 ? 'Emergency contacts' : 'Emergency contact'}</h3>` +
    `<p class="muted">Provided by the owner</p>${rows}${shareLocation(contacts[0]!, ownerName)}</section>`
  );
}

function profileView(data: PublicEmergencyDto, emergencyNumber: string): string {
  const p: PublicEmergencyProfileDto = data.profile ?? {};
  const facts: string[] = [];
  if (p.age !== undefined) facts.push(`Age ${p.age}`);
  if (p.dateOfBirth) facts.push(`Born ${p.dateOfBirth}`);
  if (p.gender) facts.push(p.gender.charAt(0) + p.gender.slice(1).toLowerCase().replace(/_/g, ' '));
  if (p.organDonor !== undefined) facts.push(p.organDonor ? 'Organ donor' : 'Not an organ donor');

  const out: string[] = [];
  if (p.name || p.photoUrl || facts.length) {
    const photo = p.photoUrl
      ? `<img class="photo" src="${esc(p.photoUrl)}" alt="${esc(p.name ? `Photo of ${p.name}` : 'Photo of the owner')}" width="88" height="88" decoding="async">`
      : '';
    out.push(
      `<section class="card person-card"><div class="person">${photo}<div><h3>Name</h3><p class="name">${esc(p.name ?? 'Not shared')}</p></div></div>` +
        (facts.length
          ? `<div class="facts">${facts.map((f) => `<span class="fact">${esc(f)}</span>`).join('')}</div>`
          : '') +
        '</section>',
    );
  }
  // Who, then what to do, then the Medical ID (blood group, allergies first), then who to call,
  // then notes. No product data at all.
  out.push(sceneCard(emergencyNumber));
  const medical = [
    medGroup('Allergies', p.allergies, 'allergy'),
    medGroup('Medical conditions', p.medicalConditions),
    medGroup('Medications', p.medications),
  ].join('');
  if (medical || p.bloodGroupLabel)
    out.push(
      `<section class="card medical" aria-label="Medical information"><div class="med-head"><h3>Medical ID</h3>` +
        (p.bloodGroupLabel
          ? `<div class="blood-badge" aria-label="${esc(`Blood group ${p.bloodGroupLabel}`)}"><span>Blood</span><strong>${esc(p.bloodGroupLabel)}</strong></div>`
          : '') +
        `</div>${medical}</section>`,
    );
  if (data.contacts?.length) out.push(contactsCard(data.contacts, p.name));
  if (p.emergencyNotes)
    out.push(
      `<section class="card"><h3>Other notes</h3><p class="notes">${esc(p.emergencyNotes)}</p></section>`,
    );
  if (out.length === 1)
    out.push(
      messageCard('Emergency profile', 'The owner has chosen not to share details publicly.'),
    );
  out.push(`<p class="disclaimer">${esc(data.message)}</p>`);
  const summary = buildEmergencySummaryText(data);
  if (summary)
    out.push(
      // <template>: inert and outside the document tree (not shown, not read aloud, not found).
      `<template id="summary-text">${esc(summary)}</template>` +
        `<section class="actions no-print" id="share-actions" aria-label="Share this information" hidden>` +
        `<button class="btn btn-secondary" type="button" id="copy-summary">Copy medical information</button>` +
        `<button class="btn btn-secondary" type="button" id="print-page">Print emergency information</button>` +
        `<p class="muted" role="status" aria-live="polite" id="share-status"></p></section>`,
    );
  if (data.safetyId.code)
    out.push(`<p class="safety-id">Safety ID <code>${esc(data.safetyId.code)}</code></p>`);
  return out.join('');
}

const INACTIVE_TITLES: Record<'DAMAGED' | 'REPLACED' | 'DEACTIVATED' | 'RECALLED', string> = {
  DAMAGED: 'Marked as damaged',
  REPLACED: 'Replaced',
  DEACTIVATED: 'No longer active',
  RECALLED: 'Product recall',
};

/** The whole page as one HTML document, plus the HTTP status to send. */
export function renderEmergencyPage(
  result: EmergencyPageResult,
  opts: EmergencyPageOptions,
): { status: number; html: string } {
  let top = header('Emergency information');
  let main = '';
  let status = 200;

  if (result.kind === 'ok') {
    const d = result.data;
    switch (d.state) {
      case 'ACTIVE':
        top = header('Emergency information', 'Safety ID · Emergency');
        main = profileView(d, opts.emergencyNumber);
        break;
      case 'NOT_ACTIVATED':
        main =
          `<section class="card strong"><h2>Safety ID not activated</h2><p class="lead">${esc(d.message)}</p>` +
          `<p class="muted">Ready to activate. You’ll need the Activation PIN printed with this Safety ID.</p>` +
          `<a class="btn btn-cta mt-20" href="/activate?t=${esc(encodeURIComponent(opts.token))}">Activate Safety ID</a></section>`;
        break;
      case 'LOST':
      case 'STOLEN': {
        const title = d.state === 'LOST' ? 'Reported lost' : 'Reported stolen';
        top = header(title, 'Safety ID', true);
        main = messageCard(title, d.message, 'danger');
        break;
      }
      case 'DAMAGED':
      case 'RECALLED':
      case 'REPLACED':
      case 'DEACTIVATED': {
        const title = INACTIVE_TITLES[d.state];
        top = header(title, d.profile ? 'Safety ID · Emergency' : 'Safety ID', true);
        // A damaged/recalled linked helmet that was already sharing keeps the approved
        // information, with the lifecycle warning first; otherwise no personal data at all.
        main = d.profile
          ? messageCard(title, d.warning ?? d.message, 'danger') +
            profileView(d, opts.emergencyNumber)
          : messageCard(title, d.message);
        break;
      }
      default:
        main = messageCard('Safety ID', d.message);
    }
    if (d.linkedProduct)
      main += `<p class="muted no-print verify-link"><a href="/verify/${esc(encodeURIComponent(opts.token))}">View product information</a></p>`;
  } else if (result.kind === 'not-found') {
    status = 404;
    main =
      messageCard(
        'We could not find this Safety ID',
        'This QR code is not in the registry. It may be damaged or mistyped. In an emergency, call the number below.',
      ) + sceneCard(opts.emergencyNumber);
  } else if (result.kind === 'rate-limited') {
    status = 429;
    main = messageCard(
      'Please wait a moment',
      'Too many requests from this network. Try again in a minute. In an emergency, call the number below.',
    );
  } else {
    status = 503;
    main =
      `<section class="card" role="alert"><h2>Couldn’t load information</h2><p class="lead">This may be a temporary problem. Check your connection and try again. In an emergency, call the number below.</p>` +
      `<a class="btn btn-secondary mt-16" href="/e/${esc(encodeURIComponent(opts.token))}">Try again</a></section>` +
      sceneCard(opts.emergencyNumber);
  }

  const n = opts.emergencyNumber;
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="theme-color" content="#fffefb"><meta name="robots" content="noindex, nofollow">' +
    '<meta name="referrer" content="no-referrer"><title>Emergency information · Safety ID</title>' +
    // data: favicon: no extra request competing for a weak connection.
    `<link rel="icon" href="data:,"><style>${EMERGENCY_PAGE_CSS}</style></head><body>` +
    `<div id="app">${top}<main class="content">${main}</main></div>` +
    `<footer class="call-bar"><a id="call-emergency" class="btn btn-danger" href="${esc(tel(n))}" aria-label="${esc(`Call emergency services on ${n}`)}">${esc(`Call emergency ${n}`)}</a></footer>` +
    (result.kind === 'ok' ? `<script>${PAGE_SCRIPT}</script>` : '') +
    '</body></html>';
  return { status, html };
}
