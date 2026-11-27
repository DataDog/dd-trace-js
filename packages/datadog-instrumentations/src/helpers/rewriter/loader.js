'use strict'

/* eslint n/no-unsupported-features/node-builtins: ['error', { ignores: ['module.registerHooks'] }] */

const Module = require('node:module')
const { isMainThread } = require('node:worker_threads')

const shimmer = require('../../../../datadog-shimmer')
const log = require('../../../../dd-trace/src/log')
const { getLoaderMode, isSyncLoaderHookVersionSupported } = require('../../../../dd-trace/src/register-loader')
const { hasRewriteMarker } = require('./rewrite-marker')
const { rewrite } = require('./')

/**
 * @typedef {import('node:module').LoadHookContext} LoadContext
 * @typedef {import('node:module').LoadFnOutput} LoadResult
 * @typedef {(url: string, context: LoadContext) => LoadResult} NextLoad
 * @typedef {{ deregister: () => void }} ScopedHook
 * @typedef {(hooks: { load: typeof loadEsmDependency }) => ScopedHook} RegisterHooks
 */

const { registerHooks } = /** @type {{ registerHooks?: RegisterHooks }} */ (Module)
const canUseScopedHooks = isMainThread && module instanceof Module &&
  typeof registerHooks === 'function' && isSyncLoaderHookVersionSupported()

/** @type {ScopedHook | undefined} */
let scopedHook

shimmer.wrap(Module.prototype, '_compile', compile => function (content, filename, format) {
  if (format !== 'module') {
    return compile.call(this, rewrite(content, filename, format), filename, format)
  }

  const mode = getLoaderMode()
  // The explicit sync loader already rewrote this entry before _compile.
  if (mode === 'sync') return compile.call(this, content, filename, format)

  const source = rewrite(content, filename, format)
  if (mode === 'async' || scopedHook || !canUseScopedHooks) {
    return compile.call(this, source, filename, format)
  }

  try {
    scopedHook = registerHooks({ load: loadEsmDependency })
  } catch (error) {
    log.error('Could not register the scoped ESM rewrite hook: %s', error)
    return compile.call(this, source, filename, format)
  }

  // Node links the static imports of require(esm) here; they never reach _compile.
  try {
    return compile.call(this, source, filename, format)
  } finally {
    scopedHook.deregister()
    scopedHook = undefined
  }
})

/**
 * @param {string} url
 * @param {LoadContext} context
 * @param {NextLoad} nextLoad
 */
function loadEsmDependency (url, context, nextLoad) {
  const result = nextLoad(url, context)
  if ((result.format ?? context.format) !== 'module' || result.source == null ||
      !url.startsWith('file:') ||
      // A nested require(esm) goes through _compile. Let it rewrite its own entry.
      context.conditions?.includes('require') ||
      // An explicit async Datadog loader may already have rewritten this source in nextLoad().
      hasRewriteMarker(result.source)) return result

  result.source = rewrite(result.source, url, 'module')
  return result
}
