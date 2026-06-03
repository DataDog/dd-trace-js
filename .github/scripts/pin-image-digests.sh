#!/usr/bin/env bash
# Resolves mutable image tags to immutable digests and writes .github/image-digests.json.
# Reads: PLAYWRIGHT_IMAGES (JSON), SELENIUM_IMAGE (URL with tag)
# Writes: .github/image-digests.json
# Appends: playwright-images and selenium-image to $GITHUB_OUTPUT
set -euo pipefail
GITHUB_OUTPUT=${GITHUB_OUTPUT:-/dev/null}

resolve_digest() {
  docker buildx imagetools inspect "$1" | awk '/^Digest:/{print $2; exit}'
}

PW_BASE="ghcr.io/datadog/dd-trace-js/playwright-tools"
PW_LATEST_TAG=$(echo "$PLAYWRIGHT_IMAGES" | jq -r '.latest')
PW_OLDEST_TAG=$(echo "$PLAYWRIGHT_IMAGES" | jq -r '.oldest')
PW_LATEST="${PW_BASE}@$(resolve_digest "$PW_LATEST_TAG")"
PW_OLDEST="${PW_BASE}@$(resolve_digest "$PW_OLDEST_TAG")"
PW_PINNED=$(printf '{"latest":"%s","oldest":"%s"}' "$PW_LATEST" "$PW_OLDEST")
echo "playwright-images=$PW_PINNED" >> "$GITHUB_OUTPUT"

SE_BASE="ghcr.io/datadog/dd-trace-js/selenium-tools"
SE_PINNED="${SE_BASE}@$(resolve_digest "$SELENIUM_IMAGE")"
echo "selenium-image=$SE_PINNED" >> "$GITHUB_OUTPUT"

jq -n \
  --argjson pw "$PW_PINNED" \
  --arg se "$SE_PINNED" \
  '{"playwright-tools": $pw, "selenium-tools": {"default": $se}}' \
  > .github/image-digests.json
