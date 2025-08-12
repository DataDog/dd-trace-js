#!/usr/bin/env sh

npx esbuild integration-tests/debugger/target-app/source-map-support/typescript.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --packages=external \
  --sourcemap \
  --sources-content=false \
  --outfile=integration-tests/debugger/target-app/source-map-support/bundle.js

# For testing that relative paths in the sources array also work
sed -i '' 's/hello\/world.ts/hello\/.\/world.ts/g' integration-tests/debugger/target-app/source-map-support/bundle.js.map
