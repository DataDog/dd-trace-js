'use strict'

/* eslint-disable no-var */

var path = require('path')
var Module = require('module')
var isTrue = require('./util').isTrue
var log = require('./log')
var telemetry = require('./telemetry')
var nodeVersion = require('../../../../version')

var NODE_MAJOR = nodeVersion.NODE_MAJOR

function guard (fn) {
  var initBailout = false
  var clobberBailout = false
  var forced = isTrue(process.env.DD_INJECT_FORCE)
  var engines = require('../../../../package.json').engines
  var minMajor = parseInt(engines.node.replace(/[^0-9]/g, ''))
  var version = process.versions.node

  if (process.env.DD_INJECTION_ENABLED) {
    // If we're running via single-step install, and we're in the app's
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
      var ourselves = path.normalize(path.join(__dirname, '..', '..', '..', '..', 'index.js'))
      if (ourselves !== resolvedInApp) {
        clobberBailout = true
      }
    }
  }

  // If the runtime doesn't match the engines field in package.json, then we
  // should not initialize the tracer.
  if (!clobberBailout && NODE_MAJOR < minMajor) {
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

  if (!clobberBailout && (!initBailout || forced)) {
    var result = fn()
    telemetry('complete', ['injection_forced:' + (forced && initBailout ? 'true' : 'false')])
    log.info('Application instrumentation bootstrapping complete')
    return result
  }
}

module.exports = guard
