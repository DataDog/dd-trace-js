#!/usr/bin/env sh

# Regenerate throws.js / throws.js.map from throws.ts. The emitted JS is committed and run by
# source-maps.spec.js (mirroring integration-tests/code-origin). tsc reports type errors for the
# untyped node/fastify globals and exits non-zero, but still emits the JS, which is all we need.
npx --package=typescript -- tsc --sourceMap --module commonjs --target ES2020 \
  integration-tests/source-maps/throws.ts

# tsc omits a trailing newline; add one so the committed file passes editorconfig.
printf '\n' >> integration-tests/source-maps/throws.js
