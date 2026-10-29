'use strict'

/**
 * Get the name of the runtime if it can't run Live Debugger/Dynamic Instrumentation, or `undefined` if it can.
 *
 * Live Debugger/Dynamic Instrumentation needs the Debugger domain of the `node:inspector` module. Bun only implements a
 * few of its methods, never returns their results, and never emits its events. Deno doesn't let worker threads
 * connect to the main thread inspector. Deno reports a Node.js `process.version`, so both runtimes are detected by
 * their own `process.versions` entry instead.
 */
function getUnsupportedRuntime () {
  if (process.versions.bun !== undefined) return 'Bun'
  if (process.versions.deno !== undefined) return 'Deno'
}

module.exports = { getUnsupportedRuntime }
