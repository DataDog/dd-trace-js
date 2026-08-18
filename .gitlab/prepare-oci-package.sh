#!/bin/bash

set -e

cd ..

archive=$(npm pack --silent)
test -f "$archive"

bun=$(node scripts/bun.js)

mkdir -p packaging/sources

# Install from the manifest before unpacking dd-trace, otherwise its prepare script recursively rebuilds vendor.
tar -xOf "$archive" package/package.json > packaging/sources/package.json
npm pkg delete scripts.prepare --prefix packaging/sources
cp bun.lock packaging/sources/bun.lock
"$bun" --config="$PWD/bunfig.toml" install --production --frozen-lockfile \
  --linker=hoisted --network-concurrency 8 --cwd packaging/sources

rm packaging/sources/package.json packaging/sources/bun.lock
mkdir -p packaging/sources/node_modules/dd-trace
# The OCI layout expects dd-trace beside its hoisted production dependencies in the shared node_modules.
tar -xzf "$archive" --strip-components=1 -C packaging/sources/node_modules/dd-trace

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json)${CI_VERSION_SUFFIX}"
fi

printf '%s' "$JS_PACKAGE_VERSION" > packaging/sources/version

cd packaging

cp ../requirements.json sources/requirements.json
