'use strict'

// The late-start variant runs a bundle that loads electron before the tracer, the order Rollup and Rolldown (Vite)
// produce when they hoist external modules above the bundled tracer.
if (process.env.DD_ELECTRON_TEST_LATE_START) {
  require('./late-start.bundle.js')
} else {
  require('./tracer')

  const start = require('./app')
  start(require('electron/main'))
}
