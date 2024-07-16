'use strict'

const path = require('path')
const Module = require('module')
const semver = require('semver')
const { isTrue } = require('./packages/dd-trace/src/util')
const telemetry = require('./packages/dd-trace/src/telemetry/init-telemetry')

const log = semver.satisfies(process.versions.node, '>=16')
  ? require('./packages/dd-trace/src/log')
  : { info: isTrue(process.env.DD_TRACE_DEBUG) ? console.log : () => {} } // eslint-disable-line no-console

let initBailout = false
let clobberBailout = false
const forced = isTrue(process.env.DD_INJECT_FORCE)

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
      clobberBailout = true
    }
  }

  // If we're running via single-step install, and the runtime doesn't match
  // the engines field in package.json, then we should not initialize the tracer.
  if (!clobberBailout) {
    const { engines } = require('./package.json')
    const version = process.versions.node
    if (!semver.satisfies(version, engines.node)) {
      initBailout = true
      telemetry([
        { name: 'abort', tags: ['reason:incompatible_runtime'] },
        { name: 'abort.runtime', tags: [] }
      ])
      log.info('Aborting application instrumentation due to incompatible_runtime.')
      log.info(`Found incompatible runtime nodejs ${version}, Supported runtimes: nodejs ${engines.node}.`)
      if (forced) {
        log.info('DD_INJECT_FORCE enabled, allowing unsupported runtimes and continuing.')
      }
    }
  }
}

if (!clobberBailout && (!initBailout || forced)) {
  const tracer = require('.')
  tracer.init()
  module.exports = tracer
  telemetry('complete', [`injection_forced:${forced && initBailout ? 'true' : 'false'}`])
  log.info('Application instrumentation bootstrapping complete')
}
