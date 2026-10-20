'use strict'

const Module = require('node:module')
const dc = require('dc-polyfill')

const log = require('../../../dd-trace/src/log')
const { IS_SERVERLESS } = require('../../../dd-trace/src/serverless')
const { activate, loadChannel } = require('./register.js')
const {
  filename,
  getDisabledInstrumentations,
  matchVersion,
  matchesInstrumentation,
} = require('./instrumentation-utils')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const { isNodeBuiltinModuleName } = require('./shared-utils')
const { isRewriteActivationEnabled } = require('./rewriter/targets')
const disabledInstrumentations = getDisabledInstrumentations()

// Built-ins cached by a bundle before register.js installed ritm must pass through
// Node's real require again. Hooks mutate the shared exports object in place;
// synchronizing afterwards also updates already-created native ESM named exports.
const bundlerKey = Symbol.for('dd-trace:bundler')
/** @type {import('./bundler-banner').BundlerRecord | undefined} */
const existingRecord = globalThis[bundlerKey]
/** @type {import('./bundler-banner').BundlerRecord} */
const bundlerRecord = globalThis[bundlerKey] ??= { bundlers: [] }
let builtinsPatched = false
bundlerRecord.onBundle = patchBundledBuiltins

// A plugin banner marks the process as bundled even when dd-trace is external or preloaded. Without one,
// a bundled tracer is still recognizable because its module wrapper is not a Module instance.
if (existingRecord || !(module instanceof Module)) {
  patchBundledBuiltins()
}

function patchBundledBuiltins () {
  if (builtinsPatched) return
  // Mark before requiring to prevent re-entrant hooks and repeated failed loads.
  builtinsPatched = true

  let loaded = false
  for (const name of Object.keys(hooks)) {
    if (!isNodeBuiltinModuleName(name) || disabledInstrumentations.has(name)) continue
    if (IS_SERVERLESS && hooks[name].serverless === false) continue

    try {
      Module.prototype.require.call(module, name)
      loaded = true
    } catch (error) {
      log.error('Error instrumenting bundled built-in %s: %s', name, String(error?.message ?? error), error)
    }
  }
  if (!loaded) return
  try {
    Module.syncBuiltinESMExports()
  } catch (error) {
    log.error('Error synchronizing bundled built-in ESM exports: %s', String(error?.message ?? error), error)
  }
}

const CHANNEL = 'dd-trace:bundler:load'

if (!dc.subscribe) {
  dc.subscribe = (channel, cb) => {
    dc.channel(channel).subscribe(cb)
  }
}
if (!dc.unsubscribe) {
  dc.unsubscribe = (channel, cb) => {
    if (dc.channel(channel).hasSubscribers) {
      dc.channel(channel).unsubscribe(cb)
      return true
    }
    return false
  }
}

/**
 * @param {string} name
 */
function doHook (name) {
  const hook = hooks[name] ?? hooks[`node:${name}`]
  if (!hook) {
    log.error('esbuild-wrapped %s missing in list of hooks', name)
    return
  }

  const hookFn = hook.fn ?? hook
  if (typeof hookFn !== 'function') {
    log.error('esbuild-wrapped hook %s is not a function', name)
    return
  }

  try {
    hookFn()
  } catch (error) {
    log.error('esbuild-wrapped %s hook failed: %s', name, String(error?.message ?? error), error)
  }
}

/**
 * @typedef {object} Payload
 * @property {boolean} [activate]
 * @property {string} package
 * @property {unknown} [module]
 * @property {string} [version]
 * @property {string} [path]
 */

/** @type {Set<string>} */
const instrumentedNodeModules = new Set()

dc.subscribe(CHANNEL, (message) => {
  const payload = /** @type {Payload} */ (message)
  const name = payload.package
  if (disabledInstrumentations.has(name)) return

  if (payload.activate && isRewriteActivationEnabled(name)) {
    activate(name, payload.version)
    return
  }

  const isPrefixedWithNode = name.startsWith('node:')
  const isNodeModule = isPrefixedWithNode || !hooks[name]

  if (isNodeModule) {
    const nodeName = isPrefixedWithNode ? name.slice(5) : name
    // Used for node: prefixed modules to prevent double instrumentation.
    if (instrumentedNodeModules.has(nodeName)) {
      return
    }
    instrumentedNodeModules.add(nodeName)
  }

  doHook(name)

  const instrumentation = instrumentations[name] ?? instrumentations[`node:${name}`]

  if (!instrumentation) {
    if (!payload.activate) log.error('esbuild-wrapped %s missing in list of instrumentations', name)
    return
  }

  if (payload.activate) {
    for (const { sourceRewrite, versions, hook } of instrumentation) {
      if (!sourceRewrite || payload.path !== filename(name, sourceRewrite) ||
        !matchVersion(payload.version, versions)) continue

      try {
        loadChannel.publish({ name })
        hook(undefined, payload.version)
      } catch (error) {
        log.error('Error executing bundler hook: %s', String(error?.message ?? error), error)
      }
      return
    }
    return
  }

  for (const entry of instrumentation) {
    if (!matchesInstrumentation(name, payload.version, payload.path, entry)) continue

    try {
      loadChannel.publish({ name })
      payload.module = entry.hook(payload.module, payload.version) ?? payload.module
    } catch (error) {
      log.error('Error executing bundler hook: %s', String(error?.message ?? error), error)
    }
  }
})
