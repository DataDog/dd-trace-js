'use strict'

const path = require('path')
const Module = require('module')

let initBailout = false

if (process.env.DD_INJECTION_ENABLED) {
  // If we're running via single-step install, and we're not in the app's
  // node_modules, then we should not initialize the tracer. This prevents
  // single-step-installed tracer from clobbering the manually-installed tracer.
  let resolvedInApp
  const entrypoint = process.argv[1]
  try {
    resolvedInApp = Module.createRequire(entrypoint).resolve('dd-trace')
  } catch (e) {
    // Ignore. If we can't resolve the module, we assume it's not in the app.
  }
  if (resolvedInApp) {
    const ourselves = path.join(__dirname, 'index.js')
    if (ourselves !== resolvedInApp) {
      initBailout = true
    }
  }
}

if (!initBailout) {
  const tracer = require('.')
  tracer.init()
  module.exports = tracer
}
