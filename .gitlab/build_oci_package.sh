#!/bin/bash

set -e

cd ..

npm pack

mkdir -p packaging/sources

npm install --prefix ./packaging/sources/ dd-trace-*.tgz

rm packaging/sources/*.json # package.json and package-lock.json are unneeded

jq --raw-output '.version' package.json > packaging/sources/version

cd packaging

export VERSION=$(<sources/version)

datadog-package create \
  --version="$VERSION" \
  --package="datadog-apm-library-js" \
  --archive=true \
  --archive-path="datadog-apm-library-js-$VERSION.tar" \
  ./sources
