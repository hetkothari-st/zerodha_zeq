#!/usr/bin/env bash
# Asserts the public surface of a Funnel server (and optionally ws-hub) is locked down.
# Usage: scripts/security-check.sh https://funnel-op-staging.up.railway.app [https://ws-hub-staging.up.railway.app]
set -u
BASE="${1:?usage: security-check.sh <app-base-url> [hub-base-url]}"
HUB="${2:-}"
fail=0

# Reachability guard: ensure server is responding
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
if [ "$code" != "200" ]; then echo "FAIL server unreachable at $BASE"; exit 1; fi

expect() { # METHOD PATH EXPECTED_STATUS
    local code
    code=$(curl -s -o /dev/null -w '%{http_code}' -X "$1" "$BASE$2" -H 'Content-Type: application/json' --data '{}')
    if [ "$code" = "$3" ]; then echo "ok   $1 $2 -> $code"; else echo "FAIL $1 $2 -> $code (expected $3)"; fail=1; fi
}

expect GET  /api/kite-config            401
expect POST /api/set-access-token       401
expect POST /api/exchange-token         401
expect POST /api/admin/kite/login-url   401
expect GET  /api/admin/users            401
expect POST /api/login                  404
expect POST /api/force-logout           404
expect GET  /api/active-sessions        404

# Verify unauthenticated path rejects leaks; authenticated response tested in test/kite.test.js
resp=$(curl -s -w '\n%{http_code}' "$BASE/api/kite-config")
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -n 1)
if [ "$status" = "401" ] && echo "$body" | grep -q '"code":"unauthenticated"' && ! echo "$body" | grep -qE 'accessToken|access_token'; then
    echo "ok   /api/kite-config has no token"
else
    echo "FAIL /api/kite-config -> $status (expected 401 with unauthenticated error, no token)"
    fail=1
fi
resp=$(curl -s -w '\n%{http_code}' "$BASE/connect")
body=$(echo "$resp" | head -n -1)
status=$(echo "$resp" | tail -n 1)
if [ "$status" = "200" ] && [ -n "$body" ] && ! echo "$body" | grep -q "Funnel Launcher"; then
    echo "ok   /connect launcher gone"
else
    echo "FAIL /connect -> $status (expected 200 with body, no launcher)"
    fail=1
fi

loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/kite/callback?request_token=x&status=success")
case "$loc" in
    *kite=expired*) echo "ok   /kite/callback without state refused" ;;
    *) echo "FAIL /kite/callback without state -> '$loc'"; fail=1 ;;
esac

if curl -sI "$BASE/" | grep -qi "content-security-policy:.*frame-ancestors 'none'"; then echo "ok   CSP frame-ancestors none"; else echo "FAIL CSP header missing"; fail=1; fi

if [ -n "$HUB" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$HUB/api/update-token" --data '{"access_token":"x"}')
    if [ "$code" = "401" ]; then echo "ok   hub update-token requires secret"; else echo "FAIL hub update-token -> $code"; fail=1; fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: https://evil.example' "$HUB/")
    if [ "$code" = "403" ]; then echo "ok   hub rejects foreign origin"; else echo "FAIL hub foreign origin -> $code"; fail=1; fi
fi

exit $fail
