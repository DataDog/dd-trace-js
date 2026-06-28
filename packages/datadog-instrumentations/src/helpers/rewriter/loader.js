'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { rewrite } = require('./')

// When the synchronous loader owns CommonJS, it rewrites CJS source in the
// `load` hook, so rewriting here too would double-instrument. Node runs `-r`
// preloads before `--import`, so this module can be evaluated before
// register.js sets the ownership flag; checking it per compile (rather than
// once at load) lets the entrypoint and every later module see the final
// decision, since they all compile after `--import` has run.
const ownsCjsSync = Symbol.for('dd-trace:sync-loader-owns-cjs')
shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  if (globalThis[ownsCjsSync] === true) {
    return compile.call(this, content, filename, format)
  }
  return compile.call(this, rewrite(content, filename, format), filename, format)
})
