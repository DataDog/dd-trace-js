'use strict'

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
  var telemetryModule = require('./telemetry')

  if (process.env.DD_INJECTION_ENABLED) {
    // If we're running via single-step install, and we're in the app's
    // node_modules, then we should not initialize the tracer. This prevents
    // single-step-installed tracer from clobbering the manually-installed tracer.
    var resolvedInApp
    var entrypoint = process.argv[1]
    try {
      // eslint-disable-next-line n/no-unsupported-features/node-builtins
      resolvedInApp = Module.createRequire(entrypoint).resolve('dd-trace')
    } catch (e) {
      // Ignore. If we can't resolve the module, we assume it's not in the app.
      // TODO: There's also the possibility that this version of Node.js doesn't have Module.createRequire (pre v12.2.0)
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
    telemetryModule.resultMetadata.result = 'abort'
    telemetryModule.resultMetadata.result_reason = 'Aborting application instrumentation due to incompatible_runtime.'
    telemetryModule.resultMetadata.result_class = 'incompatible_runtime'
    telemetry([
      { name: 'abort', tags: ['reason:incompatible_runtime'] },
      { name: 'abort.runtime', tags: [] }
    ])
    log.info('Aborting application instrumentation due to incompatible_runtime.')
    log.info('Found incompatible runtime nodejs %s, Supported runtimes: nodejs %s.', version, engines.node)
    if (forced) {
      log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
      telemetryModule.resultMetadata.result = 'success'
      telemetryModule.resultMetadata.result_reason = 'DD_INJECT_FORCE enabled, allowing unsupported runtimes'
      telemetryModule.resultMetadata.result_class = 'success_forced'
    }
  }

  if (!clobberBailout && (!initBailout || forced)) {
    // Ensure the instrumentation source is set for the current process and potential child processes.
    var result = fn()
    telemetryModule.resultMetadata.result = 'success'
    telemetryModule.resultMetadata.result_reason = 'Successfully configured ddtrace package'
    telemetryModule.resultMetadata.result_class = 'success'
    telemetry('complete', ['injection_forced:' + (forced && initBailout ? 'true' : 'false')])
    log.info('Application instrumentation bootstrapping complete')
    return result
  }
}

module.exports = guard
