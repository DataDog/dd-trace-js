'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { rewrite } = require('./')

// When the synchronous loader owns CommonJS, it rewrites CJS source in the
// `load` hook, so patching Module._compile here would double-rewrite. Only
// install the _compile rewriter when the sync loader has not taken over.
if (globalThis[Symbol.for('dd-trace:sync-loader-owns-cjs')] !== true) {
  shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
    return compile.call(this, rewrite(content, filename, format), filename, format)
  })
}
