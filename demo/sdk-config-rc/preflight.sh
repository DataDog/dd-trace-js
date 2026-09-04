#!/usr/bin/env bash
# Validate a demo APM_TRACING payload against the REAL dd-go backend code.
#
# Copies preflight/preflight_test.go into a local dd-go checkout, runs it there (so dd-go's own
# module graph and 55 replace directives apply), then always removes it again. The dd-go tree is
# left exactly as it was found; the script refuses to run if that tree is already dirty.
#
# Usage:
#   ./preflight.sh [payload.json]
#   DD_GO_DIR=/path/to/dd-go ./preflight.sh payload.json
#
# Defaults to payloads/profiling-enable.json.

set -euo pipefail

cd "$(dirname "$0")"

DD_GO_DIR="${DD_GO_DIR:-/Users/rachel.yang/dd/dd-go}"
PAYLOAD="${1:-payloads/profiling-enable.json}"
PKG_DIR="remote-config/pkg/products/apmtracing/sdkconfigsecurity"
DEST="$DD_GO_DIR/$PKG_DIR/zz_demo_preflight_test.go"

if [ ! -f "$PAYLOAD" ]; then
  echo "preflight: payload not found: $PAYLOAD" >&2
  exit 1
fi

if [ ! -d "$DD_GO_DIR/$PKG_DIR" ]; then
  echo "preflight: dd-go package not found at $DD_GO_DIR/$PKG_DIR" >&2
  echo "preflight: set DD_GO_DIR to a dd-go checkout containing ddoghq/dd-go#14029" >&2
  exit 1
fi

# Refuse to touch a dirty tree, so cleanup can never be mistaken for discarding real work.
if [ -n "$(git -C "$DD_GO_DIR" status --porcelain)" ]; then
  echo "preflight: $DD_GO_DIR has uncommitted changes; refusing to write a temp file into it" >&2
  exit 1
fi

cleanup() {
  rm -f "$DEST"
}
trap cleanup EXIT INT TERM

echo "preflight: dd-go   = $DD_GO_DIR"
echo "preflight: dd-go @ $(git -C "$DD_GO_DIR" log -1 --format='%h %s')"
echo "preflight: payload = $PAYLOAD"
echo

cp preflight/preflight_test.go "$DEST"

status=0
DEMO_PAYLOAD="$(cd "$(dirname "$PAYLOAD")" && pwd)/$(basename "$PAYLOAD")" \
GOFLAGS=-mod=mod \
  go -C "$DD_GO_DIR" test "./$PKG_DIR/" -run TestDemoPayloadPreflight -v -count=1 || status=$?

# Remove the temp file before verifying, so the check reflects the tree we leave behind.
cleanup
echo
if [ -n "$(git -C "$DD_GO_DIR" status --porcelain)" ]; then
  echo "preflight: WARNING - dd-go tree is dirty after the run" >&2
else
  echo "preflight: dd-go tree left clean"
fi
exit $status
