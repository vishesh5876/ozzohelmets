#!/usr/bin/env node
/**
 * Seeds a STAGING / TEST deployment through its public HTTPS API with synthetic helmets and
 * customers, for load tests and restore drills. Never point it at production with real customers.
 *
 *   SEED_CONFIRM=staging BASE_ADMIN=https://admin.helmet.test BASE_PORTAL=https://safe.helmet.test \
 *   ADMIN_EMAIL=… ADMIN_PASSWORD=… HELMETS=200 CUSTOMERS=50 node loadtest/seed.mjs > loadtest/seed-data.json
 *
 * Output (stdout, JSON): QR tokens of activated helmets (with published emergency profiles), of
 * unactivated helmets, and customer credentials — all synthetic. Progress goes to stderr.
 * Set NODE_TLS_REJECT_UNAUTHORIZED=0 only for a self-signed staging origin.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

const env = (k, d) => process.env[k] ?? d;
if (env('SEED_CONFIRM') !== 'staging') {
  console.error('Refusing: set SEED_CONFIRM=staging to confirm this is not production.');
  process.exit(2);
}
const ADMIN = env('BASE_ADMIN', 'https://admin.helmet.test');
const PORTAL = env('BASE_PORTAL', 'https://safe.helmet.test');
const HELMETS = Number(env('HELMETS', '200'));
const CUSTOMERS = Math.min(Number(env('CUSTOMERS', '50')), HELMETS);
const PASSWORD = env('CUSTOMER_PASSWORD', 'load test rider password');
const run = Date.now().toString(36);
const log = (...a) => console.error('[seed]', ...a);

async function call(base, path, { method = 'GET', token, body, form, headers = {} } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text).data;
  } catch {
    return text;
  }
}

/** Minimal valid PNG (64×64 grey) without dependencies. */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const w = 64,
    h = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // 8-bit greyscale
  const raw = Buffer.alloc((w + 1) * h, 128);
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

async function main() {
  const login = await call(ADMIN, '/admin/auth/login', {
    method: 'POST',
    body: { email: env('ADMIN_EMAIL'), password: env('ADMIN_PASSWORD') },
  });
  const admin = login.accessToken;
  const model = await call(ADMIN, '/admin/helmet-models', {
    method: 'POST',
    token: admin,
    body: {
      name: `Load Model ${run}`,
      sku: `LT-${run.toUpperCase()}`,
      brand: 'Ozzo',
      warrantyMonths: 24,
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  const batch = await call(ADMIN, '/admin/batches', {
    method: 'POST',
    token: admin,
    body: { helmetModelId: model.id, quantity: HELMETS, manufacturingDate: today },
  });
  await call(ADMIN, `/admin/batches/${batch.id}/generate`, { method: 'POST', token: admin });
  for (;;) {
    const b = await call(ADMIN, `/admin/batches/${batch.id}`, { token: admin });
    if (b.generationStatus === 'COMPLETED') break;
    if (b.generationStatus === 'FAILED') throw new Error('batch generation failed');
    await sleep(1000);
  }
  const csv = await call(ADMIN, `/admin/batches/${batch.id}/export/manufacturing.csv`, {
    token: admin,
  });
  await call(ADMIN, `/admin/batches/${batch.id}/mark-printed`, { method: 'POST', token: admin });
  const rows = String(csv)
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(','));
  const helmets = rows.map(([helmetCode, , , , qrUrl, pin]) => ({
    helmetCode,
    token: qrUrl.split('/e/')[1],
    pin,
  }));
  log(`manufactured ${helmets.length} helmets`);

  const customers = [];
  const photo = png();
  for (let i = 0; i < CUSTOMERS; i++) {
    const h = helmets[i];
    const email = `lt.${run}.${i}@example.test`;
    const reg = await call(PORTAL, '/customer/activation/register', {
      method: 'POST',
      body: { publicToken: h.token, pin: h.pin, email, password: PASSWORD },
    });
    const token = reg.accessToken;
    await call(PORTAL, '/customer/emergency-profile', {
      method: 'PUT',
      token,
      body: {
        name: `Synthetic Rider ${i}`,
        bloodGroup: 'O_POSITIVE',
        allergies: ['Synthetic allergy'],
      },
    });
    await call(PORTAL, '/customer/emergency-contacts', {
      method: 'POST',
      token,
      body: { name: `Synthetic Contact ${i}`, relationship: 'Sibling', phone: '+919812345678' },
    });
    await call(PORTAL, '/customer/emergency-visibility', {
      method: 'PUT',
      token,
      body: {
        showName: true,
        showPhoto: true,
        showBloodGroup: true,
        showDateOfBirth: false,
        showGender: false,
        showAllergies: true,
        showMedicalConditions: false,
        showMedications: false,
        showEmergencyNotes: false,
        showOrganDonor: false,
        showEmergencyContacts: true,
      },
    });
    const owned = await call(PORTAL, '/customer/helmets', { token });
    const helmetId = owned[0].id;
    await call(PORTAL, `/customer/helmets/${helmetId}/emergency/enable`, { method: 'POST', token });
    if (i < Number(env('UPLOADS', '10'))) {
      const fp = new FormData();
      fp.append('photo', new Blob([photo], { type: 'image/png' }), 'photo.png');
      await call(PORTAL, '/customer/emergency-profile/photo', { method: 'PUT', token, form: fp });
      await call(PORTAL, `/customer/helmets/${helmetId}/warranty`, {
        method: 'POST',
        token,
        body: { purchaseDate: today },
      });
      const fd = new FormData();
      fd.append('proof', new Blob([PDF], { type: 'application/pdf' }), 'invoice.pdf');
      await call(PORTAL, `/customer/helmets/${helmetId}/warranty/proof`, {
        method: 'POST',
        token,
        form: fd,
      });
    }
    customers.push({
      email,
      password: PASSWORD,
      helmetId,
      helmetCode: h.helmetCode,
      token: h.token,
    });
    if ((i + 1) % 10 === 0) log(`activated ${i + 1}/${CUSTOMERS}`);
  }
  process.stdout.write(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        activeTokens: customers.map((c) => c.token),
        unactivatedTokens: helmets.slice(CUSTOMERS).map((h) => h.token),
        customers,
      },
      null,
      2,
    ),
  );
  log('done');
}

main().catch((err) => {
  console.error('[seed] failed:', err.message);
  process.exit(1);
});
