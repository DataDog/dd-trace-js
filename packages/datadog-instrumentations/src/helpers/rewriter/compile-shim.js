'use strict'

const rewrittenForCompileSymbol = Symbol.for('dd-trace.loader.rewritten-for-compile')

let compileShimInstalled = false
let getRewriteTarget
let rewrite

/**
 * Installs the CommonJS compiler fallback once.
 *
 * @returns {void}
 */
function ensureCompileShim () {
  if (compileShimInstalled) return

  const Module = require('module')
  const shimmer = require('../../../../datadog-shimmer')
  getRewriteTarget = require('./targets.js').getRewriteTarget

  shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
    const rewritten = globalThis[rewrittenForCompileSymbol]?.delete(filename)
      ? content
      : rewriteCompile(content, filename, format)

    return compile.call(this, rewritten, filename, format)
  })

  compileShimInstalled = true
}

/**
 * Reports whether this module installed the CommonJS compiler fallback.
 *
 * @returns {boolean}
 */
function isCompileShimInstalled () {
  return compileShimInstalled
}

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

module.exports = { ensureCompileShim, isCompileShimInstalled }
