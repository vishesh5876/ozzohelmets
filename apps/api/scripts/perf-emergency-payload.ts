/* eslint-disable no-console */
/**
 * Public emergency payload check (docs/SAFETY-ID.md → "Performance"), against a running API:
 *
 *   ts-node --transpile-only scripts/perf-emergency-payload.ts <apiBase> <publicToken> [requests=200]
 *
 * apiBase like http://localhost:4000/api/v1. Reports the JSON size (raw and gzip) of the emergency
 * and verify responses plus sequential latency percentiles (first request = cold cache). Use a
 * Safety ID of a test account with a complete profile; the token is printed only as a prefix.
 * Every request is a real scan, so run it with scan recording off or against a test environment.
 */
import { gzipSync } from 'node:zlib';

const [base, token, n = '200'] = process.argv.slice(2);
if (!base || !token) {
  console.error('usage: perf-emergency-payload.ts <apiBase> <publicToken> [requests]');
  process.exit(2);
}

const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

async function measure(path: string, requests: number) {
  const times: number[] = [];
  let body = '';
  for (let i = 0; i < requests; i++) {
    const t0 = performance.now();
    const res = await fetch(`${base}${path}`, { headers: { 'user-agent': 'perf-payload' } });
    body = await res.text();
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    times.push(performance.now() - t0);
  }
  const cold = times[0]!;
  const warm = times.slice(1).sort((a, b) => a - b);
  const data = JSON.parse(body).data as { state?: string };
  return {
    endpoint: path.replace(token!, `${token!.slice(0, 4)}…`),
    state: data.state ?? '-',
    bytes: Buffer.byteLength(body),
    gzipBytes: gzipSync(body).length,
    coldMs: Math.round(cold),
    p50Ms: +pct(warm, 50).toFixed(1),
    p95Ms: +pct(warm, 95).toFixed(1),
    p99Ms: +pct(warm, 99).toFixed(1),
  };
}

async function main() {
  const requests = Number(n);
  const rows = [
    await measure(`/public/emergency/${token}`, requests),
    await measure(`/public/verify/${token}`, Math.min(requests, 50)),
  ];
  console.log(`\n${requests} sequential requests (verify: ${Math.min(requests, 50)})\n`);
  console.table(rows);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
