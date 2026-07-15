#!/usr/bin/env sh
set -e

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
FIXTURES="$ROOT/integration-tests/source-maps"
OUTPUT="$FIXTURES"

if [ "${1:-}" = --check ]; then
  OUTPUT=$(mktemp -d "${TMPDIR:-/tmp}/dd-source-map-fixtures.XXXXXX")
  trap 'rm -rf -- "$OUTPUT"' 0 1 2 15
  cp "$FIXTURES/throws.ts" "$OUTPUT"
fi

"$ROOT/node_modules/.bin/tsc" --sourceMap --module Node16 --moduleResolution Node16 \
  --target ES2020 --esModuleInterop --skipLibCheck --types node \
  --outDir "$OUTPUT" "$OUTPUT/throws.ts"

if [ "${1:-}" = --check ]; then
  for fixture in throws.js throws.js.map; do
    cmp -s "$OUTPUT/$fixture" "$FIXTURES/$fixture" || {
      echo "$fixture is stale; run npm run generate:source-map-fixtures." >&2
      exit 1
    }
  done
fi
