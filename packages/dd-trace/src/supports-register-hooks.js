'use strict'

const FIRST_ELECTRON_MAJOR_WITH_SYNC_HOOKS = 43

/**
 * Whether `module.registerHooks()` load hooks can be installed on this runtime.
 *
 * Registering a synchronous load hook below Electron 43 makes Node reject the
 * default load step for `electron:electron`, killing the app on its first
 * `require('electron')`. Electron 43.0.0 exempted `electron:` URLs from that
 * validation. `module.register()` is unaffected on every version.
 *
 * @returns {boolean}
 */
function supportsRegisterHooks () {
  const { electron } = process.versions

  if (electron === undefined) return true

  return Number.parseInt(electron, 10) >= FIRST_ELECTRON_MAJOR_WITH_SYNC_HOOKS
}

module.exports = supportsRegisterHooks
