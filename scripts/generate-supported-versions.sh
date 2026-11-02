#!/bin/sh
# Entry point for the CI job that publishes supported_versions.json.
set -eu
cd "$(dirname "$0")/.."
yarn install --frozen-lockfile
node scripts/generate-supported-versions.js
