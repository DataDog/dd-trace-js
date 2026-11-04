#!/bin/bash

set -e

cd ..

archive=$(npm pack --silent)
test -f "$archive"

mkdir -p packaging/sources
printf '{}\n' > packaging/sources/package.json

bun_version=$(node -p 'require("./package.json").devDependencies.bun')
npm exec --yes --package="bun@$bun_version" -- bun add --cwd ./packaging/sources/ "$PWD/$archive"
rm packaging/sources/*.json packaging/sources/bun.lock

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json)${CI_VERSION_SUFFIX}"
fi

printf '%s' "$JS_PACKAGE_VERSION" > packaging/sources/version

cd packaging

cp ../requirements.json sources/requirements.json
