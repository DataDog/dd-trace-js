'use strict'

/* eslint-disable no-var */

var NODE_MAJOR = require('./version').NODE_MAJOR

// We use several things that are not supported by older versions of Node:
// - AsyncLocalStorage
// - The `semver` module
// - dc-polyfill
// - Mocha (for testing)
// and probably others.
// TODO: Remove all these dependencies so that we can report telemetry.
if (NODE_MAJOR >= 12) {
  var path = require('path')
  var Module = require('module')
  var semver = require('semver')
  var log = require('./packages/dd-trace/src/log')
  var isTrue = require('./packages/dd-trace/src/util').isTrue
  var telemetry = require('./packages/dd-trace/src/telemetry/init-telemetry')

  var initBailout = false
  var clobberBailout = false
  var forced = isTrue(process.env.DD_INJECT_FORCE)

  if (process.env.DD_INJECTION_ENABLED) {
    // If we're running via single-step install, and we're not in the app's
    // node_modules, then we should not initialize the tracer. This prevents
    // single-step-installed tracer from clobbering the manually-installed tracer.
    var resolvedInApp
    var entrypoint = process.argv[1]
    try {
      resolvedInApp = Module.createRequire(entrypoint).resolve('dd-trace')
    } catch (e) {
      // Ignore. If we can't resolve the module, we assume it's not in the app.
    }
    if (resolvedInApp) {
      var ourselves = path.join(__dirname, 'index.js')
      if (ourselves !== resolvedInApp) {
        clobberBailout = true
      }
    }

    // If we're running via single-step install, and the runtime doesn't match
    // the engines field in package.json, then we should not initialize the tracer.
    if (!clobberBailout) {
      var engines = require('./package.json').engines
      var version = process.versions.node
      if (!semver.satisfies(version, engines.node)) {
        initBailout = true
        telemetry([
          { name: 'abort', tags: ['reason:incompatible_runtime'] },
          { name: 'abort.runtime', tags: [] }
        ])
        log.info('Aborting application instrumentation due to incompatible_runtime.')
        log.info('Found incompatible runtime nodejs ' + version + ', Supported runtimes: nodejs ' + engines.node + '.')
        if (forced) {
          log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
        }
      }
    }
  }

  if (!clobberBailout && (!initBailout || forced)) {
    var tracer = require('.')
    tracer.init()
    module.exports = tracer
    telemetry('complete', ['injection_forced:' + (forced && initBailout ? 'true' : 'false')])
    log.info('Application instrumentation bootstrapping complete')
  }
}
