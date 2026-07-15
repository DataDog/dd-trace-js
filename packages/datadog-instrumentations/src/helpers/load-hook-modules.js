'use strict'

/** @typedef {(() => void) | { fn?: () => void } | null} Hook */

/**
 * Loads instrumentation modules that register export hooks.
 *
 * @param {Record<string, Hook>} hooks
 * @returns {void}
 */
module.exports = function loadHookModules (hooks) {
  for (const hook of Object.values(hooks)) {
    const hookFunction = typeof hook === 'function' ? hook : hook?.fn
    hookFunction?.()
  }
}
