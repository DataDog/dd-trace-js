'use strict'

/**
 * Whether `module.registerHooks()` load hooks can be installed on this runtime.
 *
 * Electron exposes its built-in modules to the ESM loader as `electron:electron`
 * with `format: 'electron'` and a nullish source. Node validates the default load
 * step's own result as soon as a *synchronous* load hook is registered (`#loadSync`
 * in lib/internal/modules/esm/loader.js switches to `validateLoadSloppy` when
 * `syncLoadHooks.length` is non-zero), and that validation only tolerates a nullish
 * source for `format: 'commonjs'`, a `node:` URL or `format: 'addon'`. Electron
 * matches none of them, so `nextLoad()` throws ERR_INVALID_RETURN_PROPERTY_VALUE
 * before any hook body runs and the application dies on its first
 * `require('electron')`.
 *
 * `module.register()` is unaffected — its validator in esm/hooks.js accepts a
 * nullish source for any format — so only this API needs the exclusion, and the
 * asynchronous loader keeps working in Electron. Every `module.registerHooks()`
 * consumer hits this, not only ours, so it belongs upstream in Electron rather
 * than being worked around per consumer.
 *
 * @returns {boolean}
 */
function supportsRegisterHooks () {
  return process.versions.electron === undefined
}

module.exports = supportsRegisterHooks
