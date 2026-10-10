// k6 load scenarios for a STAGING deployment seeded by loadtest/seed.mjs (synthetic data only).
//
//   docker run --rm -i --network <stack>_edge -e SCENARIO=emergency_cached -e BASE=http://portal:8080 \
//     -e ADMIN_BASE=http://admin:8080 -e ADMIN_EMAIL=… -e ADMIN_PASSWORD=… \
//     -v $PWD/loadtest:/lt grafana/k6 run /lt/k6/scenarios.js
//
// SCENARIO: emergency_cached | emergency_uncached | verify | customer_login | customer_dashboard |
//           admin_analytics | mixed | login_flood. RATE and DURATION override the defaults.
// All traffic comes from one IP, so staging must raise the per-IP limits for capacity runs
// (docs/PHASE-7.md#load-test); production keeps them.
import http from 'k6/http';
import { check, fail } from 'k6';
import { SharedArray } from 'k6/data';

const data = JSON.parse(open('/lt/seed-data.json'));
const active = new SharedArray('active', () => data.activeTokens);
const all = new SharedArray('all', () => data.activeTokens.concat(data.unactivatedTokens));
const customers = new SharedArray('customers', () => data.customers);

const BASE = __ENV.BASE || 'http://portal:8080';
const ADMIN_BASE = __ENV.ADMIN_BASE || 'http://admin:8080';
const SCENARIO = __ENV.SCENARIO || 'emergency_cached';
const DURATION = __ENV.DURATION || '60s';
const json = { headers: { 'Content-Type': 'application/json' } };

const DEFAULT_RATE = {
  emergency_cached: 200,
  emergency_uncached: 25, // 1300 tokens / 25 rps → each token revisited after > 30 s cache TTL
  verify: 50,
  customer_login: 5, // Argon2id (64 MiB, t=3) per attempt — intentionally expensive
  customer_dashboard: 30,
  admin_analytics: 5,
};

function scenario(name, exec, rate) {
  return {
    executor: 'constant-arrival-rate',
    exec,
    rate: Number(__ENV.RATE || rate),
    timeUnit: '1s',
    duration: DURATION,
    preAllocatedVUs: 50,
    maxVUs: 400,
    tags: { scenario: name },
  };
}

const ALL_SCENARIOS = {
  emergency_cached: scenario('emergency_cached', 'emergencyCached', DEFAULT_RATE.emergency_cached),
  emergency_uncached: scenario(
    'emergency_uncached',
    'emergencyUncached',
    DEFAULT_RATE.emergency_uncached,
  ),
  verify: scenario('verify', 'verify', DEFAULT_RATE.verify),
  customer_login: scenario('customer_login', 'customerLogin', DEFAULT_RATE.customer_login),
  customer_dashboard: scenario(
    'customer_dashboard',
    'customerDashboard',
    DEFAULT_RATE.customer_dashboard,
  ),
  admin_analytics: scenario('admin_analytics', 'adminAnalytics', DEFAULT_RATE.admin_analytics),
};

export const options = {
  scenarios:
    SCENARIO === 'login_flood'
      ? {
          // Emergency traffic while logins arrive faster than the API can hash passwords:
          // emergency latency must stay low (Argon2 concurrency is capped).
          emergency_cached: scenario('emergency_cached', 'emergencyCached', 100),
          customer_login: scenario('customer_login', 'customerLogin', 15),
        }
      : SCENARIO === 'mixed'
        ? {
            emergency_cached: scenario('emergency_cached', 'emergencyCached', 100),
            emergency_uncached: scenario('emergency_uncached', 'emergencyUncached', 15),
            verify: scenario('verify', 'verify', 20),
            customer_login: scenario('customer_login', 'customerLogin', 2),
            customer_dashboard: scenario('customer_dashboard', 'customerDashboard', 15),
            admin_analytics: scenario('admin_analytics', 'adminAnalytics', 2),
          }
        : { [SCENARIO]: ALL_SCENARIOS[SCENARIO] },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:emergency_cached}': ['p(95)<300'],
    'http_req_duration{scenario:emergency_uncached}': ['p(95)<800'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const out = { customerTokens: [], adminToken: null };
  if (SCENARIO === 'customer_dashboard' || SCENARIO === 'mixed') {
    for (const c of customers.slice(0, 20)) {
      const r = http.post(
        `${BASE}/api/v1/customer/auth/login`,
        JSON.stringify({ identifier: c.email, password: c.password }),
        json,
      );
      if (r.status !== 200) fail(`login failed: ${r.status}`);
      out.customerTokens.push(r.json('data.accessToken'));
    }
  }
  if (SCENARIO === 'admin_analytics' || SCENARIO === 'mixed') {
    const r = http.post(
      `${ADMIN_BASE}/api/v1/admin/auth/login`,
      JSON.stringify({ email: __ENV.ADMIN_EMAIL, password: __ENV.ADMIN_PASSWORD }),
      json,
    );
    if (r.status !== 200) fail(`admin login failed: ${r.status}`);
    out.adminToken = r.json('data.accessToken');
  }
  return out;
}

export function emergencyCached() {
  const token = active[Math.floor(Math.random() * Math.min(20, active.length))];
  const r = http.get(`${BASE}/api/v1/public/emergency/${token}`, { tags: { name: 'emergency' } });
  check(r, { 200: (x) => x.status === 200 });
}

let cursor = 0;
export function emergencyUncached() {
  const token = all[(cursor++ * 37 + __VU * 101) % all.length];
  const r = http.get(`${BASE}/api/v1/public/emergency/${token}`, { tags: { name: 'emergency' } });
  check(r, { 200: (x) => x.status === 200 });
}

export function verify() {
  const token = active[Math.floor(Math.random() * active.length)];
  const r = http.get(`${BASE}/api/v1/public/verify/${token}`, { tags: { name: 'verify' } });
  check(r, { 200: (x) => x.status === 200 });
}

export function customerLogin() {
  const c = customers[Math.floor(Math.random() * customers.length)];
  const r = http.post(
    `${BASE}/api/v1/customer/auth/login`,
    JSON.stringify({ identifier: c.email, password: c.password }),
    {
      ...json,
      tags: { name: 'login' },
    },
  );
  check(r, { 200: (x) => x.status === 200 });
}

export function customerDashboard(ctx) {
  const token = ctx.customerTokens[Math.floor(Math.random() * ctx.customerTokens.length)];
  const h = { headers: { Authorization: `Bearer ${token}` }, tags: { name: 'dashboard' } };
  const r = http.get(`${BASE}/api/v1/customer/dashboard`, h);
  check(r, { 200: (x) => x.status === 200 });
}

export function adminAnalytics(ctx) {
  const h = { headers: { Authorization: `Bearer ${ctx.adminToken}` }, tags: { name: 'analytics' } };
  const path =
    Math.random() < 0.5
      ? '/api/v1/admin/analytics/overview?range=30d'
      : '/api/v1/admin/analytics/scans?range=30d';
  const r = http.get(`${ADMIN_BASE}${path}`, h);
  check(r, { 200: (x) => x.status === 200 });
}
