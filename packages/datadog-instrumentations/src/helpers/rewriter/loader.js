'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('module')
const { isMainThread } = require('node:worker_threads')

const rewrittenForCompileSymbol = Symbol.for('dd-trace.loader.rewritten-for-compile')
const fullSyncLoaderSymbol = Symbol.for('dd-trace.loader.full-sync')

// `register.js` installs the full loader, so the tracer entrypoint's narrower
// load hook has nothing left to install. The compile hook remains as a fallback
// for CommonJS whose source another hook intentionally leaves nullish.
if (!globalThis[fullSyncLoaderSymbol]) registerRequireLoadHook()
wrapCompile()

/**
 * Rewrites require()d source through a Node.js load hook, which reports the
 * module format. The compile hook remains installed for nullish-source loads.
 *
 * @returns {void}
 */
function registerRequireLoadHook () {
  if (typeof Module.registerHooks !== 'function') return

  // Node runs `--require` preloads inside the ESM loader thread as well, and that
  // thread's loader customizations expose no synchronous load step, so chaining a
  // load hook there fails every ESM load it serves with `loadSync is not a
  // function`. Node 24.11.1 and 25.1.0 made that step optional; Node 22 never did.
  if (!isMainThread) return

  if (!require('../../../../dd-trace/src/supports-register-hooks')()) return

  try {
    // `module.registerHooks` exists since Node 22.15, but until nodejs/node#59929
    // (22.22.3, 24.11.1, 25.1.0, 26.0.0) its load hook rejected the nullish
    // CommonJS source Node reports for builtins and for require()s pulled into the
    // ESM graph, throwing ERR_INVALID_RETURN_PROPERTY_VALUE for loads this hook
    // only passes through. Below the fix the compile fallback is the only option.
    if (!require('import-in-the-middle/supports-sync-hooks.mjs').supportsSyncHooks()) return

    const { getFormat, hasRequireCondition, rewriteSyncResult } = require('./hooks.js')

    Module.registerHooks({
      load (url, context, nextLoad) {
        const result = nextLoad(url, context)
        if (globalThis[fullSyncLoaderSymbol]) return result

        const format = getFormat(result, context)
        if (format !== 'commonjs' && !hasRequireCondition(context.conditions)) return result

        return rewriteSyncResult(result, url, format, context.conditions)
      },
    })
  } catch (error) {
    require('../../../../dd-trace/src/log')
      .warn('Could not register the require() rewriter load hook: %s', error.message)
  }
}

/**
 * Rewrites source at compile time when no load hook supplied it.
 *
 * @returns {void}
 */
function wrapCompile () {
  const shimmer = require('../../../../datadog-shimmer')
  const { rewrite } = require('./')

  shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
    // Source supplied by the synchronous hook still reaches the compiler. The
    // filename marker survives wrappers that omit Node's third `format` argument.
    if (globalThis[rewrittenForCompileSymbol]?.delete(filename)) {
      return compile.call(this, content, filename, format)
    }

    return compile.call(this, rewrite(content, filename, format), filename, format)
  })
}
