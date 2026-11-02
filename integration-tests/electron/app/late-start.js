'use strict'

// Bundled with esbuild into late-start.bundle.js. The application holds the electron exports before the bundled
// tracer starts, so the tracer has to patch the exports that were already loaded.
const electron = require('electron')

require('./tracer')

const start = require('./app')
start(electron)
