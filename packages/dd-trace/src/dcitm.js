'use strict'

const dc = require('diagnostics_channel')

const CHANNEL_PREFIX = 'dd-trace:bundledModuleLoadStart'

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

module.exports = DcitmHook

/**
 * This allows for listening to diagnostic channel events when a module is loaded.
 * Currently it's intended use is for situations like when code runs through a bundler.
 *
 * Unlike RITM and IITM, which have files available on a filesystem at runtime, DCITM
 * requires access to a package's version ahead of time as the package.json file likely
 * won't be available.
 *
 * This function runs many times at startup, once for every module that dd-trace may trace.
 * As it runs on a per-module basis we're creating per-module channels.
 */
function DcitmHook (moduleNames, options, onrequire) {
  if (!(this instanceof DcitmHook)) return new DcitmHook(moduleNames, options, onrequire)

  function onModuleLoad (payload) {
    payload.module = onrequire(payload.module, payload.path, undefined, payload.version)
  }

  for (const moduleName of moduleNames) {
    // dc.channel(`${CHANNEL_PREFIX}:${moduleName}`).subscribe(onModuleLoad)
    dc.subscribe(`${CHANNEL_PREFIX}:${moduleName}`, onModuleLoad)
  }

  this.unhook = function dcitmUnload () {
    for (const moduleName of moduleNames) {
      // dc.channel(`${CHANNEL_PREFIX}:${moduleName}`).unsubscribe(onModuleLoad)
      dc.unsubscribe(`${CHANNEL_PREFIX}:${moduleName}`, onModuleLoad)
    }
  }
}
