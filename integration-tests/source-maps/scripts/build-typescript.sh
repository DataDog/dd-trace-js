#!/usr/bin/env sh

set -e

ROOT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
SOURCE_DIRECTORY="$ROOT_DIRECTORY/integration-tests/source-maps"
OUTPUT_DIRECTORY="$SOURCE_DIRECTORY"
SOURCE_FILE="$SOURCE_DIRECTORY/throws.ts"
TEMPORARY_DIRECTORY=

cleanup() {
  if [ -n "$TEMPORARY_DIRECTORY" ]; then
    rm -rf -- "$TEMPORARY_DIRECTORY"
  fi
}
trap cleanup 0 1 2 15

if [ "${1:-}" = '--check' ]; then
  TEMPORARY_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/dd-source-map-fixtures.XXXXXX")
  OUTPUT_DIRECTORY="$TEMPORARY_DIRECTORY"
  SOURCE_FILE="$TEMPORARY_DIRECTORY/throws.ts"
  cp "$SOURCE_DIRECTORY/throws.ts" "$SOURCE_FILE"
fi

"$ROOT_DIRECTORY/node_modules/.bin/tsc" --sourceMap --module Node16 --moduleResolution Node16 \
  --target ES2020 --esModuleInterop --skipLibCheck --types node \
  --outDir "$OUTPUT_DIRECTORY" "$SOURCE_FILE"

# tsc omits a trailing newline; add one so the committed file passes editorconfig.
printf '\n' >> "$OUTPUT_DIRECTORY/throws.js"

if [ -n "$TEMPORARY_DIRECTORY" ]; then
  for fixture in throws.js throws.js.map; do
    if ! cmp -s "$OUTPUT_DIRECTORY/$fixture" "$SOURCE_DIRECTORY/$fixture"; then
      printf '%s\n' "integration-tests/source-maps/$fixture is stale; run npm run generate:source-map-fixtures." >&2
      exit 1
    fi
  done
fi
