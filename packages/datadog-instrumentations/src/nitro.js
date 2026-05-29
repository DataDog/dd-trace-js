'use strict'

const { channel } = require('dc-polyfill')
const { addHook } = require('./helpers/instrument')

// h3 v2 is ESM-only. Its module load cannot be intercepted by require-in-the-middle
// (ritm only intercepts CJS). Publish eagerly so the plugin manager activates
// NitroPlugin and subscribes to 'tracing:h3.request:*' channels at instrumentation
// load time — before any user code or test setup changes NODE_PATH.
// The overhead for non-h3 users is a few inactive channel subscriptions (negligible).
channel('dd-trace:instrumentation:load').publish({ name: 'h3' })
channel('dd-trace:instrumentation:load').publish({ name: 'nitro' })

// When h3 is imported as ESM (iitm fires this callback), subclass H3 so every
// `new H3()` auto-registers h3's tracingPlugin. tracingPlugin installs the
// tracingChannel('h3.request') hooks that NitroPlugin subscribes to.
addHook({ name: 'h3', versions: ['*'] }, h3Module => {
  const OriginalH3 = h3Module?.H3
  if (typeof OriginalH3 !== 'function') return h3Module

  class H3 extends OriginalH3 {
    constructor (...args) {
      super(...args)
      try {
        // eslint-disable-next-line n/no-missing-require
        const { tracingPlugin } = require('h3/tracing')
        this.register(tracingPlugin())
      } catch {
        // Never break user apps if tracing setup fails.
      }
    }
  }

  h3Module.H3 = H3
  return h3Module
})

addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
