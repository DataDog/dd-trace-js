'use strict'

var fs = require('fs')
var path = require('path')
var Module = require('module')

var nodeVersion = require('../../../../version')
var isTrue = require('./util').isTrue
var log = require('./log')
var telemetry = require('./telemetry')

var BUNDLE_THRESHOLD = 1024 * 256 // arbitrary 256 KB filesize threshold
var NODE_MAJOR = nodeVersion.NODE_MAJOR

function guard (fn) {
  var initBailout = false
  var clobberBailout = false
  var bundleBailout = false
  var forced = isTrue(process.env.DD_INJECT_FORCE)
  var engines = require('../../../../package.json').engines
  var versions = engines.node.match(/^>=(\d+) <(\d+)$/)
  var minMajor = versions[1]
  var nextMajor = versions[2]
  var version = process.versions.node

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

    try {
      // If the application has been bundled then we probably cannot instrument it since the require() calls are gone
      // If the app was bundled using our ESBuild plugin it should have a copy of the tracer insde of it anyway.

      var stats = fs.statSync(entrypoint)

      // Check file size before reading to optimize performance
      if (stats.size > BUNDLE_THRESHOLD) {
        var contents = fs.readFileSync(entrypoint, 'utf8')

        // this only checks for ESBuild bundles, but there are many other bundlers to consider
        if (
          contents.indexOf('__defProp') !== -1 &&
          contents.indexOf('Bundled license information') !== -1
        ) {
          bundleBailout = true
        }
      }
    } catch (_err) {
      // If we can't access the entrypoint, continue without bundle detection
      bundleBailout = false
    }
  }

  // If the runtime doesn't match the engines field in package.json, then we
  // should not initialize the tracer.
  var runtimeBailout = false
  if (!clobberBailout && (NODE_MAJOR < minMajor || NODE_MAJOR >= nextMajor)) {
    initBailout = true
    runtimeBailout = true
    telemetry([
      { name: 'abort', tags: ['reason:incompatible_runtime'] },
      { name: 'abort.runtime', tags: [] }
    ], undefined, {
      result: 'abort',
      result_class: 'incompatible_runtime',
      result_reason: 'Incompatible runtime Node.js ' + version + ', supported runtimes: Node.js ' + engines.node
    })
    log.info('Aborting application instrumentation due to incompatible_runtime.')
    log.info('Found incompatible runtime Node.js %s, Supported runtimes: Node.js %s.', version, engines.node)
  }

  if (!initBailout && bundleBailout) {
    initBailout = true
    telemetry([
      { name: 'abort', tags: ['reason:incompatible_bundle'] },
      { name: 'abort.bundle', tags: [] }
    ], undefined, {
      result: 'abort',
      result_class: 'incompatible_bundle',
      result_reason: 'Application appears to be bundled, cannot instrument'
    })
    log.info('Aborting application instrumentation since application is bundled.')
  }

  if (!clobberBailout && (!initBailout || forced)) {
    if (forced && initBailout) {
      if (runtimeBailout) {
        log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
      } else if (bundleBailout) {
        log.info('DD_INJECT_FORCE enabled, allowing unsupported bundling and continuing.')
      }
    }
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
