'use strict'

const { channel } = require('dc-polyfill')
const { addHook } = require('./helpers/instrument')

// h3 v2 is ESM-only. Its module load cannot be intercepted by require-in-the-middle
// (ritm only intercepts CJS). We eagerly publish the load event so the plugin manager
// activates the nitro plugin's ServerPlugin and subscribes to 'tracing:h3.request:*'
// channels as soon as dd-trace instrumentation is loaded — before any user code runs.
channel('dd-trace:instrumentation:load').publish({ name: 'h3' })
channel('dd-trace:instrumentation:load').publish({ name: 'nitro' })

// Keep addHook registrations so the plugin also activates for users who load
// these packages before dd-trace (e.g. via --require flags that reorder loading).
addHook({ name: 'h3', versions: ['>=2'] }, h3 => h3)
addHook({ name: 'nitro', versions: ['>=3'] }, nitro => nitro)
