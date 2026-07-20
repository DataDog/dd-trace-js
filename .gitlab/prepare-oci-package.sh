#!/bin/bash

set -e

cd ..

archive=$(npm pack --silent)
test -f "$archive"

bun_version=$(node -p "require('./package.json').devDependencies.bun")
npm install --global --prefer-offline --no-audit --no-fund "bun@$bun_version"

mkdir -p packaging/sources

tar -xOf "$archive" package/package.json > packaging/sources/package.json
cp bun.lock packaging/sources/bun.lock
bun --config="$PWD/bunfig.toml" install --production --frozen-lockfile --ignore-scripts \
  --linker=hoisted --network-concurrency 8 --cwd packaging/sources

rm packaging/sources/package.json packaging/sources/bun.lock
mkdir -p packaging/sources/node_modules/dd-trace
tar -xzf "$archive" --strip-components=1 -C packaging/sources/node_modules/dd-trace

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json)${CI_VERSION_SUFFIX}"
fi

printf '%s' "$JS_PACKAGE_VERSION" > packaging/sources/version

cd packaging

cp ../requirements.json sources/requirements.json
