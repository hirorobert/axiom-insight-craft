#!/usr/bin/env bash
# Auto-dispatch route smoke tests based on session availability.
#
#   LOVABLE_BROWSER_AUTH_STATUS=injected  → run authenticated suite (session restored)
#   TEST_USER + TEST_PASS present         → run authenticated suite (password sign-in)
#   otherwise                             → run unauthenticated suite only
#
# Exit codes:
#   0  CLEAN (all executed suites passed)
#   1  FAIL  (a suite reported failures)
#   2  BLOCKED (authed suite requested but session vanished mid-run)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
status="${LOVABLE_BROWSER_AUTH_STATUS:-signed_out}"

echo "route_smoke_auto: LOVABLE_BROWSER_AUTH_STATUS=${status}"

run() {
  echo ""
  echo "▶ $*"
  "$@"
}

# Always run the public suite — it's the baseline.
run python3 "$here/route_smoke.py"
public_rc=$?

authed_rc=0
if [ "$status" = "injected" ] || { [ -n "${TEST_USER:-}" ] && [ -n "${TEST_PASS:-}" ]; }; then
  run python3 "$here/route_smoke_authed.py"
  authed_rc=$?
else
  echo ""
  echo "route_smoke_auto: authed suite skipped — no session (status=${status}, TEST_USER $( [ -n "${TEST_USER:-}" ] && echo set || echo unset ))."
fi

if [ "$public_rc" -ne 0 ] || [ "$authed_rc" -eq 1 ]; then
  exit 1
fi
if [ "$authed_rc" -eq 2 ]; then
  exit 2
fi
exit 0