'use strict'

const { channel } = require('dc-polyfill')
const shimmer = require('../../datadog-shimmer')
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

// When h3 is imported as ESM (real Nitro apps, integration tests), iitm fires this
// callback with the h3 module. We wrap H3.prototype.fetch with shimmer so that on the
// first request to any app instance, tracingPlugin() is auto-registered — no user
// opt-in needed. shimmer.wrap guards against double-wrapping via the .__wrapped flag.
addHook({ name: 'h3', versions: ['>=2'] }, h3Module => {
  const H3 = h3Module?.H3
  if (H3?.prototype?.fetch) {
    shimmer.wrap(H3.prototype, 'fetch', origFetch => function (...args) {
      if (!this.__dd_tracing_registered__) {
        this.__dd_tracing_registered__ = true
        try {
          // eslint-disable-next-line n/no-missing-require
          const { tracingPlugin } = require('h3/tracing')
          tracingPlugin()(this)
        } catch {
          // Never break user requests if tracing setup fails.
        }
      }
      return origFetch.apply(this, args)
    })
  }
})

// Keep addHook registration for nitro so the plugin activates when users
// require the nitro package directly rather than h3.
addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
