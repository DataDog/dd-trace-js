'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('module')

const syncSourceRewritingSymbol = Symbol.for('dd-trace.loader.sync-source-rewriting')

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

        // Match what the compile fallback used to see: every require() load,
        // CommonJS and require(esm) alike, and nothing reached through `import`.
        // Imported ESM belongs to the loader `register.js` installs, which is the
        // only path that ever rewrote it.
        if (globalThis[syncSourceRewritingSymbol] || !hasRequireCondition(context.conditions)) return result

        return rewriteResult(result, url, getFormat(result, context))
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
