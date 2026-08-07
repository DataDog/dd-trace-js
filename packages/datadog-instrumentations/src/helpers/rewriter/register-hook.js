'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('module')
const { isMainThread } = require('node:worker_threads')

const fullSyncLoaderSymbol = Symbol.for('dd-trace.loader.full-sync')

registerRequireHook()

/**
 * @returns {void}
 */
function registerRequireHook () {
  if (
    globalThis[fullSyncLoaderSymbol] ||
    !isMainThread ||
    typeof Module.registerHooks !== 'function' ||
    !require('../../../../dd-trace/src/supports-register-hooks')()
  ) return

  try {
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
  } catch {
    // The compile hook remains the fallback.
  }
}
