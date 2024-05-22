#!/bin/bash

set -e

cd ..

npm pack

cp dd-trace-js*.tar.gz packaging/dd-trace-js.tar.gz

mkdir -p packaging/sources

jq --raw-output '.version' package.json > packaging/sources/version

cd packaging

npm install dd-trace-js.tar.gz

cp -R node_modules sources/

export VERSION=$(<sources/version)

datadog-package create \
  --version="$VERSION" \
  --package="datadog-apm-library-js" \
  --archive=true \
  --archive-path="datadog-apm-library-$VERSION.tar" \
  ./sources
