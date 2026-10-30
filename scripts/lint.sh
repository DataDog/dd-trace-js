#!/usr/bin/env bash

# Background command failures are reported by `wait`, so errexit would not help.
set -uo pipefail

pids=()

run() {
  "$@" &
  pids+=("$!")
}

run node scripts/check_licenses.js
run node scripts/check-agents-md-size.js
run node scripts/check-no-coverage-artifacts.js
run node scripts/check-no-mcr-images.js
run node scripts/check-docker-image-shas.js
run node scripts/verify-carrier-fields.mjs
run codeowners-audit --no-report --fail-on-unowned
run node scripts/verify-exercised-tests.js

status=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

# ESLint uses all available CPUs through --concurrency=auto, so run it after the auxiliary checks.
eslint . --concurrency=auto --max-warnings 0
