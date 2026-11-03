#!/bin/bash

set -e

cd ..

archive=$(npm pack --silent)
test -f "$archive"

bun=$(node scripts/bun.js)

mkdir -p packaging/sources

# The repository lock describes dd-trace as the root; use its manifest to keep production resolutions frozen.
# npm previously installed the tarball as a dependency and skipped prepare. With this manifest as root, Bun runs it.
# The archive already contains vendor bundles and omits build scripts, so remove prepare before installing.
tar -xOf "$archive" package/package.json > packaging/sources/package.json
npm pkg delete scripts.prepare --prefix packaging/sources
cp bun.lock packaging/sources/bun.lock
"$bun" --config="$PWD/bunfig.toml" install --production --frozen-lockfile \
  --linker=hoisted --network-concurrency 8 --cwd packaging/sources

rm packaging/sources/package.json packaging/sources/bun.lock
mkdir -p packaging/sources/node_modules/dd-trace
# Unpack beside the hoisted dependencies to match the OCI image layout.
tar -xzf "$archive" --strip-components=1 -C packaging/sources/node_modules/dd-trace

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json)${CI_VERSION_SUFFIX}"
fi

printf '%s' "$JS_PACKAGE_VERSION" > packaging/sources/version

cd packaging

cp ../requirements.json sources/requirements.json
