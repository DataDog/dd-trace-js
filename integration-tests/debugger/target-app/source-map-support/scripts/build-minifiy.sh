#!/usr/bin/env sh

npx uglify-js integration-tests/debugger/target-app/source-map-support/minify.js \
  -o integration-tests/debugger/target-app/source-map-support/minify.min.js \
  --v8 \
  --source-map url=minify.min.js.map
