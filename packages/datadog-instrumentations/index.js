'use strict'

require('./src/helpers/bundler-register')
require('./src/helpers/register')
// The extension is required: bundlers that prefer `.mjs` (e.g. Vite) would otherwise pick the ESM loader hook.
require('./src/helpers/rewriter/loader.js')
