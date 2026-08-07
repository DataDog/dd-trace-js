'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('module')
const { isMainThread } = require('node:worker_threads')

const syncSourceRewritingSymbol = Symbol.for('dd-trace.loader.sync-source-rewriting')
const LOADER_FLAG = /(?:^|\s)--(?:(?:experimental-)?loader|import)(?:=|\s|$)/

// `register.js` installs a loader that already rewrites every format, so the
// tracer entrypoint has nothing left to install. It can also be installed after
// this module runs, because `--require dd-trace/init` runs before
// `--import dd-trace/register.js`, so both paths below re-read the symbol.
if (!globalThis[syncSourceRewritingSymbol] && !registerRequireLoadHook()) {
  wrapCompile()
}

/**
 * Rewrites require()d source through a Node.js load hook, which reports the
 * module format and leaves `Module.prototype._compile` unpatched.
 *
 * @returns {boolean} whether the hook was installed
 */
function registerRequireLoadHook () {
  if (typeof Module.registerHooks !== 'function') return false

  // Node runs `--require` preloads inside the ESM loader thread as well, and that
  // thread's loader customizations expose no synchronous load step, so chaining a
  // load hook there fails every ESM load it serves with `loadSync is not a
  // function`. Node 24.11.1 and 25.1.0 made that step optional; Node 22 never did.
  if (!isMainThread) return false

  // An asynchronous loader owns the ESM graph and answers for CommonJS with a
  // nullish source, so a load hook chained onto it cannot rewrite CommonJS at all.
  if (hasAsynchronousLoaderFlag()) return false

  if (!require('../../../../dd-trace/src/supports-register-hooks')()) return false

  try {
    // `module.registerHooks` exists since Node 22.15, but until nodejs/node#59929
    // (22.22.3, 24.11.1, 25.1.0, 26.0.0) its load hook rejected the nullish
    // CommonJS source Node reports for builtins and for require()s pulled into the
    // ESM graph, throwing ERR_INVALID_RETURN_PROPERTY_VALUE for loads this hook
    // only passes through. Below the fix the compile fallback is the only option.
    if (!require('import-in-the-middle/supports-sync-hooks.mjs').supportsSyncHooks()) return false

    const { getFormat, hasRequireCondition, rewriteResult } = require('./hooks.js')

    Module.registerHooks({
      load (url, context, nextLoad) {
        const result = nextLoad(url, context)

        if (globalThis[syncSourceRewritingSymbol]) return result

        // Match every load the compile fallback used to see: all CommonJS, however
        // it was reached, plus ESM pulled in through require(esm). Only imported
        // ESM never reaches Module._compile, and it belongs to the loader
        // `register.js` installs, which would otherwise rewrite it a second time.
        const format = getFormat(result, context)
        if (format !== 'commonjs' && !hasRequireCondition(context.conditions)) return result

        return rewriteResult(result, url, format)
      },
    })
  } catch (error) {
    require('../../../../dd-trace/src/log')
      .warn('Could not register the require() rewriter load hook: %s', error.message)
    return false
  }

  return true
}

/**
 * Whether this process was started with a flag that registers an ESM loader. Node
 * exposes no way to ask whether asynchronous hooks are installed, and both forms
 * run off-thread, so the flags are the only signal available before the first load.
 *
 * `--import` counts even though `register.js` uses it to install the synchronous
 * loader: that loader sets the symbol moments later and the compile shim stands
 * down for it, so reading the flag conservatively costs nothing.
 *
 * @returns {boolean}
 */
function hasAsynchronousLoaderFlag () {
  const { execArgv } = process

  for (let i = 0; i < execArgv.length; i++) {
    if (LOADER_FLAG.test(execArgv[i])) return true
  }

  return LOADER_FLAG.test(process.env.NODE_OPTIONS ?? '')
}

/**
 * Rewrites source at compile time on runtimes that cannot use a load hook.
 */
function wrapCompile () {
  const shimmer = require('../../../../datadog-shimmer')
  const { rewrite } = require('./')

  shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
    if (globalThis[syncSourceRewritingSymbol]) {
      return compile.call(this, content, filename, format)
    }

    return compile.call(this, rewrite(content, filename, format), filename, format)
  })
}
