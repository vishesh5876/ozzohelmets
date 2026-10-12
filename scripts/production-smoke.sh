#!/usr/bin/env bash
# Read-only production smoke test over public HTTPS. Safe to run any time, from anywhere:
# it never logs in, never creates or changes data, and makes about 15 requests.
#
#   scripts/production-smoke.sh                                   # defaults below
#   PORTAL=https://ozzohelmets.cloud ADMIN=https://admin.ozzohelmets.cloud \
#   API=https://api.ozzohelmets.cloud TEST_TOKEN=<public token of the internal test helmet> \
#   scripts/production-smoke.sh
#
# TEST_TOKEN (optional) is the QR token of a dedicated internal test helmet (model
# OZZO-INTERNAL-TEST, see docs/PHASE-8.md). With it the emergency and verify pages are checked
# end to end; without it only the "unknown QR" paths are checked. Never use a customer's helmet.
# Exit code: 0 all checks passed, 1 one or more failed.
set -uo pipefail

PORTAL="${PORTAL:-https://ozzohelmets.cloud}"
ADMIN="${ADMIN:-https://admin.ozzohelmets.cloud}"
API="${API:-https://api.ozzohelmets.cloud}"
TEST_TOKEN="${TEST_TOKEN:-}"
UNKNOWN_TOKEN="AAAAAAAAAAAAAAAAAAAAAA"
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAIL=1; }

# check <label> <url> <expected status> [body regex] [header regex]
check() {
  local label="$1" url="$2" want="$3" body_re="${4:-}" header_re="${5:-}"
  local code time
  read -r code time < <(curl -s -m 20 -o "$TMP/body" -D "$TMP/headers" -w '%{http_code} %{time_total}' "$url")
  if [ "$code" != "$want" ]; then fail "$label: HTTP $code (expected $want) $url"; return; fi
  if [ -n "$body_re" ] && ! grep -qE "$body_re" "$TMP/body"; then
    fail "$label: body does not match /$body_re/"; return
  fi
  if [ -n "$header_re" ] && ! grep -qiE "$header_re" "$TMP/headers"; then
    fail "$label: missing header /$header_re/"; return
  fi
  pass "$label ($code, ${time}s)"
}

echo "== Health and version"
check "API readiness" "$PORTAL/api/v1/health/ready" 200 '"status":"ok"'
check "API liveness (api host)" "$API/api/v1/health/live" 200 '"status":"ok"'
check "Internal metrics hidden (portal)" "$PORTAL/api/v1/internal/metrics" 404
check "Internal metrics hidden (api host)" "$API/api/v1/internal/metrics" 404

echo "== Surfaces and security headers"
check "Portal loads" "$PORTAL/" 200 '<div id="root"' 'strict-transport-security: max-age='
check "Portal CSP" "$PORTAL/" 200 '' "content-security-policy: default-src 'self'"
check "Admin loads" "$ADMIN/" 200 '<div id="root"' "x-frame-options: DENY"
check "Admin CSP" "$ADMIN/" 200 '' "content-security-policy: default-src 'self'"
check "Emergency page shell (strict CSP)" "$PORTAL/e/$UNKNOWN_TOKEN" 200 '' "content-security-policy: default-src 'none'"
check "Emergency page not indexed" "$PORTAL/e/$UNKNOWN_TOKEN" 200 '' 'x-robots-tag: noindex'
code=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "http://${PORTAL#https://}/")
if [ "$code" = 301 ] || [ "$code" = 308 ]; then pass "HTTP redirects to HTTPS ($code)"; else fail "HTTP → HTTPS redirect: got $code"; fi

echo "== Public QR paths"
check "Unknown QR → 404 (no detail leak)" "$PORTAL/api/v1/public/emergency/$UNKNOWN_TOKEN" 404 'SAFETY_ID_NOT_FOUND|HELMET_NOT_FOUND'
check "Unknown QR verify → NOT_VERIFIED" "$PORTAL/api/v1/public/verify/$UNKNOWN_TOKEN" 200 '"state":"NOT_VERIFIED"'
if [ -n "$TEST_TOKEN" ]; then
  check "Test helmet emergency data" "$PORTAL/api/v1/public/emergency/$TEST_TOKEN" 200 '"success":true'
  check "Test helmet verify" "$PORTAL/api/v1/public/verify/$TEST_TOKEN" 200 '"state":"VERIFIED"'
  check "Test helmet emergency page" "$PORTAL/e/$TEST_TOKEN" 200 'emergency'
else
  echo "  - TEST_TOKEN not set: skipped the end-to-end test-helmet checks"
fi

echo "== CORS"
acao=$(curl -s -m 15 -D - -o /dev/null -X OPTIONS -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' "$PORTAL/api/v1/customer/auth/login" | grep -i '^access-control-allow-origin' || true)
if [ -z "$acao" ]; then pass "Foreign origin gets no CORS approval"; else fail "CORS allowed a foreign origin: $acao"; fi

echo
if [ $FAIL = 0 ]; then echo "SMOKE OK"; else echo "SMOKE FAILED"; fi
exit $FAIL
