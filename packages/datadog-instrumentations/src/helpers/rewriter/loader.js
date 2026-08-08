'use strict'

const Module = require('module')
const shimmer = require('../../../../datadog-shimmer')
const { getRewriteTarget } = require('./targets.js')

require('./register-hook.js')

const rewrittenForCompileSymbol = Symbol.for('dd-trace.loader.rewritten-for-compile')

// The rewriter (`./index.js`) constructs both code-transformer matchers at load
// time, which is too expensive to pay on every process's `--import` path when the
// synchronous loader already handles ordinary loads. The `_compile` wrapper only
// needs it for the nullish-source fallback: a rewrite target that reaches the
// compiler without a marker. Gate the require behind that condition so the
// matchers load lazily on first actual use.
let rewrite

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  const rewritten = globalThis[rewrittenForCompileSymbol]?.delete(filename)
    ? content
    : rewriteCompile(content, filename, format)

  return compile.call(this, rewritten, filename, format)
})

/**
 * @param {string|Buffer|ArrayBuffer|Uint8Array} content
 * @param {string} filename
 * @param {string|undefined} format
 * @returns {string|Buffer|ArrayBuffer|Uint8Array}
 */
function rewriteCompile (content, filename, format) {
  if (!content || !getRewriteTarget(filename)) return content

  rewrite ??= require('./').rewrite
  return rewrite(content, filename, format)
}
