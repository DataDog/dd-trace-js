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
  var forced = isTrue(process.env.DD_INJECT_FORCE)
  var engines = require('../../../../package.json').engines
  var versions = engines.node.match(/^>=(\d+) <(\d+)$/)
  var minMajor = versions[1]
  var nextMajor = versions[2]
  var version = process.versions.node

  // Detect bailout conditions
  var bailoutReason = detectBailoutReason(minMajor, nextMajor)

  // Handle bailout
  if (bailoutReason) {
    // Clobber bailout cannot be forced - always abort
    if (bailoutReason.type === 'clobber') {
      return
    }

    // Log abort telemetry for runtime and bundle bailouts
    if (bailoutReason.type === 'runtime') {
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
    } else if (bailoutReason.type === 'bundle') {
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

    // Check if forced override applies
    if (!forced) {
      return
    }

    // Log force override
    if (bailoutReason.type === 'runtime') {
      log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
    } else if (bailoutReason.type === 'bundle') {
      log.info('DD_INJECT_FORCE enabled, allowing unsupported bundling and continuing.')
    }
  }

  // Initialize tracer
  var result = fn()
  telemetry('complete', ['injection_forced:' + (forced && bailoutReason ? 'true' : 'false')], {
    result: 'success',
    result_class: 'success',
    result_reason: 'Successfully configured ddtrace package'
  })
  log.info('Application instrumentation bootstrapping complete')
  return result
}

function detectBailoutReason (minMajor, nextMajor) {
  // Check for incompatible runtime (always check, regardless of injection mode)
  if (NODE_MAJOR < minMajor || NODE_MAJOR >= nextMajor) {
    return { type: 'runtime' }
  }

  // Only check injection-specific bailouts when DD_INJECTION_ENABLED is set
  if (!process.env.DD_INJECTION_ENABLED) {
    return null
  }

  var entrypoint = process.argv[1]

  // Check for clobber conflict (single-step vs manual install)
  var clobberConflict = checkClobberConflict(entrypoint)
  if (clobberConflict) {
    return { type: 'clobber' }
  }

  // Check for bundled application
  var isBundled = checkIfBundled(entrypoint)
  if (isBundled) {
    return { type: 'bundle' }
  }

  return null
}

function checkClobberConflict (entrypoint) {
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    var resolvedInApp = Module.createRequire(entrypoint).resolve('dd-trace')
    var ourselves = path.normalize(path.join(__dirname, '..', '..', '..', '..', 'index.js'))
    return ourselves !== resolvedInApp
  } catch (e) {
    // If we can't resolve, no conflict
    return false
  }
}

function checkIfBundled (entrypoint) {
  try {
    var stats = fs.statSync(entrypoint)

    // Check file size before reading to optimize performance
    if (stats.size <= BUNDLE_THRESHOLD) {
      return false
    }

    var contents = fs.readFileSync(entrypoint, 'utf8')

    // Check for ESBuild bundle markers
    return contents.indexOf('__defProp') !== -1 &&
      contents.indexOf('Bundled license information') !== -1
  } catch (_err) {
    // If we can't access the entrypoint, assume not bundled
    return false
  }
}

module.exports = guard
