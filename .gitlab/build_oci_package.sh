#!/bin/bash

set -e

cd ..

npm pack

mkdir -p packaging/sources

npm install --prefix ./packaging/sources/ dd-trace-*.tgz

rm packaging/sources/*.json # package.json and package-lock.json are unneeded

if [ -n "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION=${CI_COMMIT_TAG##v}
elif [ -z "$CI_COMMIT_TAG" ] && [ -z "$JS_PACKAGE_VERSION" ]; then
  JS_PACKAGE_VERSION="$(jq --raw-output '.version' package.json).pipeline.${CI_PIPELINE_ID}.beta.${CI_COMMIT_SHORT_SHA}"
fi
echo -n $JS_PACKAGE_VERSION > packaging/auto_inject-node.version
echo -n $JS_PACKAGE_VERSION > packaging/sources/version

cd packaging

datadog-package create \
  --version="$JS_PACKAGE_VERSION" \
  --package="datadog-apm-library-js" \
  --archive=true \
  --archive-path="datadog-apm-library-js-$JS_PACKAGE_VERSION.tar" \
  ./sources
