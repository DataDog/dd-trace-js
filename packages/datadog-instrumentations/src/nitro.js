'use strict'

const { channel } = require('dc-polyfill')
const { addHook } = require('./helpers/instrument')

// h3 v2 is ESM-only. Its module load cannot be intercepted by require-in-the-middle
// (ritm only intercepts CJS). We eagerly publish the load event so the plugin manager
// activates the nitro plugin's ServerPlugin and subscribes to 'tracing:h3.request:*'
// channels as soon as dd-trace instrumentation is loaded — before any user code runs.
// Guard with require.resolve so we only publish when the package is actually installed.
const loadCh = channel('dd-trace:instrumentation:load')
function publishIfInstalled (name) {
  try {
    require.resolve(name)
    loadCh.publish({ name })
  } catch {
    // Package not installed; nothing to instrument.
  }
}
publishIfInstalled('h3')
publishIfInstalled('nitro')

// When h3 is imported (ESM via iitm; CJS via ritm), replace the exported H3 class
// with a subclass whose constructor auto-registers h3's tracingPlugin. tracingPlugin
// installs the tracingChannel('h3.request') hooks that NitroPlugin subscribes to —
// without it, no tracing:h3.request:* events are ever published. Doing this in the
// constructor (vs. lazily on first request) ensures app.get/app.use routes registered
// after `new H3()` go through tracingPlugin's wrapped router from the start.
addHook({ name: 'h3', versions: ['>=2'] }, h3Module => {
  const OriginalH3 = h3Module?.H3
  if (typeof OriginalH3 !== 'function') return h3Module

  class H3 extends OriginalH3 {
    constructor (...args) {
      super(...args)
      try {
        // require('h3/tracing') resolves to the same h3 already loaded.
        // Synchronous require() of the ESM subpath works on Node 22+ (no top-level await).
        // eslint-disable-next-line n/no-missing-require
        const { tracingPlugin } = require('h3/tracing')
        // tracingPlugin sets __traced__ flags on handlers/middleware, so registering it
        // again (e.g. via user code) is a safe no-op.
        this.register(tracingPlugin())
      } catch {
        // Never break user apps if tracing setup fails (e.g. older Node, missing subpath).
      }
    }
  }

  h3Module.H3 = H3
  return h3Module
})

// Keep addHook registration for nitro so the plugin activates when users
// require the nitro package directly rather than h3. Nitro apps create H3
// instances internally, so the h3 hook above handles instrumentation transparently.
addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
