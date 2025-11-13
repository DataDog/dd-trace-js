'use strict'

/** @type {typeof import('node:diagnostics_channel')} */
const dc = require('dc-polyfill')

const {
  filename,
  loadChannel,
  matchVersion
} = require('./register.js')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const log = require('../../../dd-trace/src/log')

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
