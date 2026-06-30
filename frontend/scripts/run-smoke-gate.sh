#!/usr/bin/env sh
set -e

cd "$(dirname "$0")/.." || exit 1

if command -v npx >/dev/null 2>&1; then
  npx kill-port 3000 >/dev/null 2>&1 || true
fi

rm -rf tests/smoke/.auth

npm run build
CI=true npm run test:smoke:ci