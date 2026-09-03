#!/bin/sh
set -eu

if [ ! -f /platform/Datadog.LlmValidation.slnx ]; then
  echo "llmval: mount the llm-validation-platform checkout at /platform" >&2
  echo "  docker run -v /path/to/llm-validation-platform:/platform -v /path/to/dd-trace-js:/repo ..." >&2
  exit 2
fi

if [ ! -d /repo/.llm-validation ]; then
  echo "llmval: mount the dd-trace-js checkout at /repo (must contain .llm-validation/)" >&2
  exit 2
fi

cd /platform
exec dotnet run --project src/Datadog.LlmValidation.Cli -- run "$@"
