'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('node:module')

const { getRewriteTarget } = require('./targets')

// The tracer registers its own synchronous rewriter hook so that CommonJS apps started without a dd-trace loader
// flag still rewrite the files that an ES module loaded through require() imports. Once dd-trace's loader registers,
// it owns the rewrite and this hook is removed, so synchronous and asynchronous rewriters never run side by side.
/** @type {{ deregister: () => void } | undefined} */
let syncHook
let loaderRegistered = false
let syncRewriteActive = false
let rewriter

/**
 * Rewrites the source of a loader hook result in place when its URL is a rewrite target.
 *
 * @param {{ format?: string, source?: unknown }} result
 * @param {string} url
 * @param {{ format?: string }} context
 */
function rewriteLoadResult (result, url, context) {
  if (!result.source) return result

  const target = getRewriteTarget(url)
  if (target) {
    // Loaded on the first target so applications without one never parse the rewriter.
    if (!rewriter) rewriter = require('./index.js')
    result.source = rewriter.rewrite(result.source, url, result.format || context.format, target)
  }

  return result
}

/**
 * The synchronous load hook. It rewrites ES modules, including the files that an ES module loaded through require()
 * imports, which Module._compile never sees. The Module._compile shim rewrites CommonJS.
 *
 * @param {string} url
 * @param {{ format?: string, conditions?: string[] }} context
 * @param {(url: string, context: { format?: string }) => { format?: string, source?: unknown }} nextLoad
 */
function loadSync (url, context, nextLoad) {
  const result = nextLoad(url, context)
  if (isCommonJS(result.format || context.format, context)) return result

  return rewriteLoadResult(result, url, context)
}

/**
 * @param {string|undefined} format
 * @param {{ conditions?: string[] }} context
 */
function isCommonJS (format, context) {
  if (format) return format === 'commonjs'

  // require() of CommonJS can arrive without a format; ES modules loaded through require() report `module`.
  return context.conditions !== undefined && context.conditions.includes('require')
}

/**
 * Registers the tracer's synchronous rewriter hook, unless it or dd-trace's loader is registered already.
 */
function registerSyncHook () {
  if (syncHook || loaderRegistered || typeof Module.registerHooks !== 'function') return

  syncHook = Module.registerHooks({ load: loadSync })
  syncRewriteActive = true
}

/**
 * Hands the rewrite over to dd-trace's loader, removing the tracer's synchronous rewriter hook. The loader's hook
 * rewrites outside of import-in-the-middle, which reads a module's source to find its exports: a rewriter registered
 * before it would also rewrite that read, then rewrite the module again when it actually loads.
 *
 * @param {boolean} sync Whether the loader runs as synchronous hooks.
 */
function handOverToLoader (sync) {
  if (syncHook) {
    syncHook.deregister()
    syncHook = undefined
  }
  loaderRegistered = true
  syncRewriteActive = sync
}

/**
 * Whether a synchronous hook rewrites ES modules on this thread, including those loaded through require().
 */
function isSyncRewriteActive () {
  return syncRewriteActive
}

module.exports = {
  handOverToLoader,
  isSyncRewriteActive,
  loadSync,
  registerSyncHook,
  rewriteLoadResult,
}
