#!/bin/bash

set -e

cd ..

archive=$(npm pack --silent)
test -f "$archive"

mkdir -p packaging/sources
# Unlike npm --prefix, Bun needs a manifest here to avoid selecting the parent workspace.
printf '{}\n' > packaging/sources/package.json

# Bun enforces the release-age policy. Load the repository config explicitly because --cwd changes its lookup.
npm exec --yes --package=bun -- bun --config="$PWD/bunfig.toml" add --cwd ./packaging/sources/ "$PWD/$archive"
rm packaging/sources/*.json packaging/sources/bun.lock

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json)${CI_VERSION_SUFFIX}"
fi

printf '%s' "$JS_PACKAGE_VERSION" > packaging/sources/version

cd packaging

cp ../requirements.json sources/requirements.json
