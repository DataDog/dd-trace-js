'use strict'
// TODO: DELETE

// TODO: Figure out why we can't use the internal version.
// eslint-disable-next-line n/no-restricted-require
const dc = require('diagnostics_channel')

const CHANNEL_PREFIX = 'dd-trace:bundledModuleLoadStart'


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
function DcitmHook (packageNames, options, onrequire) {
  if (!(this instanceof DcitmHook)) return new DcitmHook(packageNames, options, onrequire)

  function onModuleLoad (payload) {
    console.log('intercept module load', payload)
    payload.module = onrequire(payload.module, payload.path, undefined, payload.version)
  }

  // TODO: need to iterate through addHook module/path combos, not just the module name
  // TODO: none of the addHook calls have run at this point :'(
  for (const packageName of packageNames) {
    // dc.channel(`${CHANNEL_PREFIX}:${packageName}`).subscribe(onModuleLoad)
    console.log(`subscribe ${CHANNEL_PREFIX}:${packageName}`)
    dc.subscribe(`${CHANNEL_PREFIX}:${packageName}`, onModuleLoad)
  }

  this.unhook = function dcitmUnload () {
    for (const packageName of packageNames) {
      // dc.channel(`${CHANNEL_PREFIX}:${packageName}`).unsubscribe(onModuleLoad)
      dc.unsubscribe(`${CHANNEL_PREFIX}:${packageName}`, onModuleLoad)
    }
  }
}
