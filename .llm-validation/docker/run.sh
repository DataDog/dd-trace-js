#!/usr/bin/env bash
# Build (once) and run the LLM Validation CLI in Docker. Host needs Docker + a
# checkout of llm-validation-platform — not a .NET SDK.
#
#   export LLMVAL_PLATFORM=/path/to/llm-validation-platform
#   .llm-validation/docker/run.sh --level minimum --fake
#   .llm-validation/docker/run.sh --level minimum --case js-perf-lens-ungated-publish --runs 1
set -euo pipefail

IMAGE="${LLMVAL_IMAGE_TAG:-llmval-dd-apm-sdk-review}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

if [ -z "${LLMVAL_PLATFORM:-}" ]; then
  echo "Set LLMVAL_PLATFORM to your llm-validation-platform checkout." >&2
  exit 2
fi
if [ ! -f "$LLMVAL_PLATFORM/Datadog.LlmValidation.slnx" ]; then
  echo "LLMVAL_PLATFORM=$LLMVAL_PLATFORM does not look like the platform repo (missing Datadog.LlmValidation.slnx)." >&2
  exit 2
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" -f "$HERE/Dockerfile" "$HERE"
fi

# Real runs (no --fake) need a gateway token. The CLI otherwise execs authanywhere
# inside the container, where that binary is not installed. Mint on the host.
FAKE=0
for arg in "$@"; do
  if [ "$arg" = "--fake" ]; then
    FAKE=1
    break
  fi
done

AUTH_DOCKER_ARGS=()
if [ "$FAKE" -eq 0 ]; then
  if [ -z "${LLMVAL_AUTH_HEADER:-}" ]; then
    if command -v ddtool >/dev/null 2>&1; then
      DC="${LLMVAL_DATACENTER:-us1.staging.dog}"
      echo "minting gateway token via ddtool (datacenter=$DC)..." >&2
      LLMVAL_AUTH_HEADER="$(ddtool auth token rapid-ai-platform --datacenter "$DC" --http-header)"
    elif command -v authanywhere >/dev/null 2>&1; then
      echo "minting gateway token via authanywhere..." >&2
      LLMVAL_AUTH_HEADER="$(authanywhere --audience rapid-ai-platform)"
    else
      echo "llmval: a real run needs gateway auth, but neither ddtool nor authanywhere is on PATH." >&2
      echo "  install ddtool, set LLMVAL_AUTH_HEADER, or pass --fake for an offline smoke." >&2
      exit 2
    fi
  fi
  if [ -z "${LLMVAL_AUTH_HEADER:-}" ]; then
    echo "llmval: gateway token came back empty." >&2
    exit 2
  fi
  export LLMVAL_AUTH_HEADER
  export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://ai-gateway.us1.staging.dog}"
  AUTH_DOCKER_ARGS=(-e LLMVAL_AUTH_HEADER -e ANTHROPIC_BASE_URL)
fi

# Only inject --base-sha when the caller did not pass one.
BASE_ARGS=()
HAS_BASE=0
for arg in "$@"; do
  case "$arg" in
    --base-sha|--base-sha=*) HAS_BASE=1 ;;
  esac
done
if [ "$HAS_BASE" -eq 0 ]; then
  BASE_ARGS=(--base-sha "${LLMVAL_BASE_SHA:-master}")
fi

# Extra docker args via LLMVAL_DOCKER_ARGS (e.g. -e ANTHROPIC_CUSTOM_HEADERS).
# shellcheck disable=SC2086
docker run --rm \
  -v "$LLMVAL_PLATFORM:/platform" \
  -v "$REPO:/repo" \
  "${AUTH_DOCKER_ARGS[@]}" \
  ${LLMVAL_DOCKER_ARGS:-} \
  "$IMAGE" \
  --repo /repo \
  "${BASE_ARGS[@]}" \
  --out /repo/.llm-validation/results.json \
  --report /repo/.llm-validation/report.md \
  --details /repo/.llm-validation/details.json \
  "$@"
