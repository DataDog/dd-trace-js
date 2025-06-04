#!/usr/bin/env sh

npx --package=typescript -- tsc --sourceMap \
  integration-tests/debugger/target-app/source-map-support/typescript.ts \
  integration-tests/debugger/target-app/source-map-support/hello/world.ts
