#!/usr/bin/env bash
node_version() {
  local file="packages/dd-trace/test/plugins/versions/package.json"
  [ -f "$file" ] && node -p \
    "require('./${file}').dependencies['node-${1}'].replace('npm:node@','')" \
    || echo "${1}"
}
case "$VERSION" in
  eol)         version=16 ;;
  # Pinned to 18 rather than derived from package.json engines.node: CI keeps testing the
  # oldest version we still exercise (18) even though the shipped engines floor is now >=22.
  # The setup action widens engines.node on the 18/20 legs.
  oldest)      version=$(node_version 18) ;;
  maintenance) version=$(node_version 20) ;;
  active)      version=$(node_version 24) ;;
  latest)      version=${LATEST_VERSION:-$(node_version 26)}
              # When a custom/nightly version is requested via latest,
              # force tracer init past the engines upper-bound guard.
              [ -n "$LATEST_VERSION" ] && echo "DD_INJECT_FORCE=true" >> "$GITHUB_ENV" || true ;;
  *)           version=$VERSION ;;
esac
echo "version=$version"
