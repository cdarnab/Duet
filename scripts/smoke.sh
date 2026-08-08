#!/usr/bin/env bash
# End-to-end smoke test against a running server.
# Usage: ./scripts/smoke.sh [base-url]
set -euo pipefail

BASE="${1:-http://localhost:8080}"
echo "Checking $BASE"

echo -n "  health ......... "
curl -fsS "$BASE/health" | grep -q '"ok":true' && echo "ok"

echo -n "  landing page ... "
curl -fsS "$BASE/" | grep -q "Duet" && echo "ok"

echo -n "  sync core ...... "
curl -fsS "$BASE/shared/sync.js" | grep -q "DuetSync" && echo "ok"

echo -n "  new room ....... "
CODE=$(curl -fsS "$BASE/api/room/new" | sed 's/.*"code":"\([A-Z0-9]*\)".*/\1/')
echo "$CODE"

echo
echo "Open these two in different browsers or devices:"
echo "  console : $BASE/companion.html#$CODE"
echo "  tv      : $BASE/tv.html#$CODE"
echo "  extension: set server to $BASE and room to $CODE"
