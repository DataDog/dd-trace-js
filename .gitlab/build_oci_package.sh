#!/bin/bash

set -e

cd ..

npm pack

cp dd-trace-*.tgz packaging/dd-trace.tgz

mkdir -p packaging/sources

jq --raw-output '.version' package.json > packaging/sources/version

cd packaging

npm install dd-trace.tgz

cp -R node_modules sources/

export VERSION=$(<sources/version)

datadog-package create \
  --version="$VERSION" \
  --package="datadog-apm-library-js" \
  --archive=true \
  --archive-path="datadog-apm-library-$VERSION.tar" \
  ./sources
