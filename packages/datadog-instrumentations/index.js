'use strict'

require('./src/helpers/bundler-register')
require('./src/helpers/register')

const syncSourceRewritingSymbol = Symbol.for('dd-trace.loader.sync-source-rewriting')

// The asynchronous loader cannot provide CommonJS source, so unsupported and
// failed synchronous registrations retain the compile fallback.
if (!globalThis[syncSourceRewritingSymbol]) {
  require('./src/helpers/rewriter/loader')
}
