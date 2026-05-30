#!/usr/bin/env bash
# CI gate: idempotency-required ESLint rule must be severity "error" before merge.
# Closes staffreview Improvement #1 — prevents silent regression to "warn".
set -euo pipefail
if ! grep -qE '"frollie-internal/idempotency-required"\s*:\s*"error"' eslint.config.js; then
  echo "FAIL: ESLint rule 'frollie-internal/idempotency-required' must be severity 'error' in eslint.config.js (currently warn or unset)."
  exit 1
fi
echo "OK: frollie-internal/idempotency-required severity is 'error'"
