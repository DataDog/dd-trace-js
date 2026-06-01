'use strict'

const Module = require('module')
const dc = require('dc-polyfill')

const log = require('../../../dd-trace/src/log')
const {
  filename,
  loadChannel,
  matchVersion,
} = require('./register.js')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')

// register.js has now set up ritm (require-in-the-middle). In bundled
// environments (webpack, esbuild), Node.js built-in modules required by
// dd-trace internal modules (e.g. http from request.js) may have been loaded
// before ritm was active. The bundler's module cache then returns those
// pre-loaded modules for any subsequent require() calls, bypassing ritm.
// Re-requiring them via the real Module.prototype.require ensures ritm applies
// their instrumentation hooks.
//
// In regular Node.js, `module` is an instance of Module. In bundlers, the
// module wrapper object is a plain object (not a Module instance), so we use
// that to detect a bundled context and avoid unintended side-effects in
// normal Node.js (e.g. shimmer-wrapping http before ESM modules load).
if (!(module instanceof Module)) {
  for (const name of ['http', 'https']) {
    try {
      Module.prototype.require.call(module, name)
    } catch {
      // Built-in not available in this environment, skip
    }
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
  } catch {
    log.error('esbuild-wrapped %s hook failed', name)
  }
}

/** @type {Set<string>} */
const instrumentedNodeModules = new Set()

/** @typedef {{ package: string, module: unknown, version: string, path: string }} Payload */
dc.subscribe(CHANNEL, (message) => {
  const payload = /** @type {Payload} */ (message)
  const name = payload.package

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
    log.error('esbuild-wrapped %s missing in list of instrumentations', name)
    return
  }

  for (const { file, versions, hook } of instrumentation) {
    if (payload.path !== filename(name, file) || !matchVersion(payload.version, versions)) {
      continue
    }

    try {
      loadChannel.publish({ name, version: payload.version, file })
      payload.module = hook(payload.module, payload.version) ?? payload.module
    } catch (e) {
      log.error('Error executing bundler hook', e)
    }
  }
})
