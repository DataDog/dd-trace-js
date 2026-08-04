'use strict'

var path = require('path')
var Module = require('module')

var nodeVersion = require('../../../../version')
var isTrue = require('./util').isTrue
var log = require('./log')
var telemetry = require('./telemetry')

var NODE_MAJOR = nodeVersion.NODE_MAJOR

function guard (fn) {
  var initBailout = false
  var clobberBailout = false
  var forced = isTrue(process.env.DD_INJECT_FORCE)
  var pkg = require('../../../../package.json')
  var engines = pkg.engines
  var versions = engines.node.match(/^>=(\d+)$/)
  var minMajor = versions[1]
  var nextMajor = pkg.nodeMaxMajor
  var version = process.versions.node
  var supportedRange = engines.node + ' <' + nextMajor

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
  if (!clobberBailout && (NODE_MAJOR < minMajor || NODE_MAJOR >= nextMajor)) {
    initBailout = true
    var runtimeInfo = 'Incompatible runtime Node.js ' + version + ', supported runtimes: Node.js ' + supportedRange
    // When not forced, the process bails out here and may call process.exit() right away;
    // forward synchronously so the telemetry child can't outlive us and wedge the exit.
    telemetry([
      { name: 'abort', tags: ['reason:incompatible_runtime'] },
      { name: 'abort.runtime', tags: [] }
    ], undefined, {
      result: 'abort',
      result_class: 'incompatible_runtime',
      result_reason: runtimeInfo
    }, !forced)
    log.info('Aborting application instrumentation due to incompatible_runtime.')
    log.info('Found incompatible runtime Node.js %s, Supported runtimes: Node.js %s.', version, supportedRange)
    if (forced) {
      log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
    }
  }

  if (!clobberBailout && (!initBailout || forced)) {
    // Ensure the instrumentation source is set for the current process and potential child processes.
    var result = fn()
    telemetry('complete', ['injection_forced:' + (forced && initBailout ? 'true' : 'false')], {
      result: 'success',
      result_class: 'success',
      result_reason: 'Successfully configured ddtrace package'
    })
    log.info('Application instrumentation bootstrapping complete')
    return result
  }
}

module.exports = guard
