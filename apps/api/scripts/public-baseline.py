#!/usr/bin/env python3
"""Phase 8 -> Phase 9 public-response replay (docs/SAFETY-ID-MIGRATION.md, "Baseline replay").

Proves that every existing printed QR keeps behaving the same after the migration: capture the
public emergency + verify responses for every token with the Phase 8 build, migrate, capture
again with the Phase 9 build, then compare per token.

  # token list from the restored copy (keep it OUTSIDE the repository; it is sensitive):
  psql "$DATABASE_URL" -Atc "SELECT public_token FROM helmets WHERE public_token IS NOT NULL" > /secure/tokens.txt
  python3 -I public-baseline.py capture http://localhost:4000/api/v1 /secure/tokens.txt /secure/p8.json
  ... prisma migrate deploy, start the Phase 9 build ...
  python3 -I public-baseline.py capture http://localhost:4000/api/v1 /secure/tokens.txt /secure/p9.json
  python3 -I public-baseline.py compare /secure/p8.json /secure/p9.json

Run it only against a NON-PUBLIC instance restored from a backup, with the public abuse limits
relaxed (VALID_TOKEN_SCRAPE_LIMIT, ENUMERATION_INVALID_TOKEN_LIMIT, THROTTLE_PUBLIC_LIMIT,
PUBLIC_MISS_LIMIT_PER_IP) and SCAN_RECORDING_ENABLED=false. Against production every request
would count as a scan and the replay would trip the scraping protection. The captures contain
emergency profiles: store them like a backup and delete them afterwards.

Expected result: zero differences except "emergency message wording (expected)" (Phase 9 copy
says "Safety ID" where Phase 8 said "helmet").
"""
import json
import sys
import time
import urllib.error
import urllib.request
from collections import Counter


def capture(base: str, tokens_file: str, out_file: str, delay: float = 0.0) -> None:
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    tokens = open(tokens_file).read().split()
    out = {}
    for token in tokens:
        row = {}
        for kind in ('emergency', 'verify'):
            url = f"{base.rstrip('/')}/public/{kind}/{token}"
            try:
                with opener.open(url, timeout=20) as resp:
                    row[kind] = [resp.status, json.load(resp)]
            except urllib.error.HTTPError as err:
                row[kind] = [err.code, json.load(err)]
            if delay:
                time.sleep(delay)
        out[token] = row
    with open(out_file, 'w') as fh:
        json.dump(out, fh)
    states = Counter((v['emergency'][0], v['emergency'][1].get('data', {}).get('state')) for v in out.values())
    print(f'captured {len(out)} tokens; emergency (status, state): {dict(states)}')
    limited = sum(1 for v in out.values() for k in v.values() if k[0] == 429)
    if limited:
        print(f'WARNING: {limited} responses were rate limited (429); relax the limits and re-run')


def compare(before_file: str, after_file: str) -> int:
    a = json.load(open(before_file))
    b = json.load(open(after_file))
    diff: Counter = Counter()
    examples: dict = {}

    def note(kind: str, token: str) -> None:
        diff[kind] += 1
        examples.setdefault(kind, token[:6] + '…')

    missing = [t for t in a if t not in b]
    for t in missing:
        note('token missing from second capture', t)
    for t in (t for t in a if t in b):
        ea, eb = a[t]['emergency'], b[t]['emergency']
        if ea[0] != eb[0]:
            note('emergency http status', t)
        da, db = ea[1].get('data', {}), eb[1].get('data', {})
        for key in ('state', 'profile', 'contacts', 'warning'):
            if da.get(key) != db.get(key):
                note(f'emergency {key}', t)
        if 'helmet' in db:
            note('product fields in emergency payload', t)
        if da.get('message') != db.get('message'):
            note('emergency message wording (expected)', t)
        va, vb = a[t]['verify'], b[t]['verify']
        if va[0] != vb[0]:
            note('verify http status', t)
        xa, xb = va[1].get('data', {}), vb[1].get('data', {})
        for key in ('state', 'product', 'lifecycle', 'activated', 'warranty', 'recallWarning', 'integrityNotice'):
            if xa.get(key) != xb.get(key):
                note(f'verify {key}', t)
        if vb[0] == 200 and not (xb.get('safetyId') or {}).get('code', '').startswith('SI-'):
            note('verify missing Safety ID code', t)
    print(f'tokens compared: {len(a)}')
    for kind, n in sorted(diff.items()):
        print(f'{n:6}  {kind}  e.g. {examples[kind]}')
    unexpected = sum(n for kind, n in diff.items() if not kind.endswith('(expected)'))
    print('RESULT:', 'OK' if unexpected == 0 else f'{unexpected} unexpected differences')
    return 0 if unexpected == 0 else 1


if __name__ == '__main__':
    if len(sys.argv) >= 5 and sys.argv[1] == 'capture':
        capture(sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]) if len(sys.argv) > 5 else 0.0)
    elif len(sys.argv) == 4 and sys.argv[1] == 'compare':
        sys.exit(compare(sys.argv[2], sys.argv[3]))
    else:
        print(__doc__)
        sys.exit(2)
