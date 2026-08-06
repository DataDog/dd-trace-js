'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('module')

const syncSourceRewritingSymbol = Symbol.for('dd-trace.loader.sync-source-rewriting')

// `register.js` installs a loader that already rewrites every format, so the
// tracer entrypoint has nothing left to install. It can also be installed after
// this module runs, because `--require dd-trace/init` runs before
// `--import dd-trace/register.js`, so both paths below re-read the symbol.
if (!globalThis[syncSourceRewritingSymbol] && !registerCommonJSLoadHook()) {
  wrapCompile()
}

/**
 * Rewrites CommonJS source through a Node.js load hook, which reports the module
 * format and leaves `Module.prototype._compile` unpatched.
 *
 * @returns {boolean} whether the hook was installed
 */
function registerCommonJSLoadHook () {
  if (typeof Module.registerHooks !== 'function') return false

  try {
    const { getFormat, rewriteResult } = require('./hooks.js')

    Module.registerHooks({
      load (url, context, nextLoad) {
        const result = nextLoad(url, context)

        if (globalThis[syncSourceRewritingSymbol]) return result

        // ESM is rewritten by the loader `register.js` installs. Rewriting it here
        // too would instrument every ESM module twice whenever both are active.
        const format = getFormat(result, context)
        if (format !== 'commonjs') return result

        return rewriteResult(result, url, format)
      },
    })
  } catch (error) {
    require('../../../../dd-trace/src/log')
      .warn('Could not register the CommonJS rewriter load hook: %s', error.message)
    return false
  }

  return true
}

/**
 * Rewrites CommonJS source at compile time on runtimes without
 * `Module.registerHooks`.
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
