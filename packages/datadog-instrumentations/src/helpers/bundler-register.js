'use strict'

const dc = require('dc-polyfill')

const log = require('../../../dd-trace/src/log')
const {
  filename,
  loadChannel,
  matchVersion,
} = require('./register.js')
const hooks = require('./hooks')
const instrumentations = require('./instrumentations')

const CHANNEL = 'dd-trace:bundler:load'

// Track all packages that were processed so plugin_manager can initialize plugins
// for them even if loadChannel.publish fired before plugin_manager.js was loaded.
const processedPackages = new Set()
module.exports = { processedPackages }

if (!dc.subscribe) {
  dc.subscribe = (channel, cb) => {
    dc.channel(channel).subscribe(cb)
  }
}
if (!dc.unsubscribe) {
  dc.unsubscribe = (channel, cb) => {
    if (dc.channel(channel).hasSubscribers) {
      dc.channel(channel).unsubscribe(cb)
    }
  }
}

function doHook (payload) {
  const hook = hooks[payload.package]
  if (!hook) {
    log.error('esbuild-wrapped %s missing in list of hooks', payload.package)
    return
  }

  const hookFn = hook.fn ?? hook
  if (typeof hookFn !== 'function') {
    log.error('esbuild-wrapped hook %s is not a function', payload.package)
    return
  }

  try {
    hookFn()
  } catch {
    log.error('esbuild-wrapped %s hook failed', payload.package)
  }
}

dc.subscribe(CHANNEL, (payload) => {
  doHook(payload)

  if (!instrumentations[payload.package]) {
    log.error('esbuild-wrapped %s missing in list of instrumentations', payload.package)
    return
  }

  for (const { name, file, versions, hook } of instrumentations[payload.package]) {
    if (payload.path !== filename(name, file)) continue
    if (!matchVersion(payload.version, versions)) continue

    try {
      processedPackages.add(name)
      loadChannel.publish({ name, version: payload.version, file })
      payload.module = hook(payload.module, payload.version)
    } catch (e) {
      log.error('Error executing bundler hook', e)
    }
  }
})
