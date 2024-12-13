'use strict'

// This code runs before the tracer is configured and before a logger is ready
// For that reason we queue up the messages now and decide what to do with them later
const warnings = []

/**
 * Here we maintain a list of packages that an application
 * may have installed which could potentially conflict with
 */
const potentialConflicts = new Set([
  '@appsignal/javascript',
  '@appsignal/nodejs',
  '@dynatrace/oneagent',
  '@instana/aws-fargate',
  '@instana/aws-lambda',
  '@instana/azure-container-services',
  '@instana/collector',
  '@instana/google-cloud-run',
  '@sentry/node',
  'appoptics-apm',
  'atatus-nodejs',
  'elastic-apm-node',
  'newrelic',
  'stackify-node-apm',
  'sqreen'
])

const extractPackageAndModulePath = require('./utils/src/extract-package-and-module-path')

/**
 * The lowest hanging fruit to debug an app that isn't tracing
 * properly is to check that it is loaded before any modules
 * that need to be instrumented. This function checks the
 * `require.cache` to see if any supported packages have
 * already been required and prints a warning.
 *
 * Note that this only going to work for modules within npm
 * packages, like `express`, and not internal modules, like
 * `http`. It also only works with CJS, not with ESM imports.
 *
 * The output isn't necessarily 100% perfect. For example if the
 * app loads a package we instrument but outside of an
 * unsupported version then a warning would still be displayed.
 * This is OK as the tracer should be loaded earlier anyway.
 */
module.exports.checkForRequiredModules = function () {
  const packages = require('../../datadog-instrumentations/src/helpers/hooks')
  const naughties = new Set()
  let didWarn = false

  for (const pathToModule of Object.keys(require.cache)) {
    const { pkg } = extractPackageAndModulePath(pathToModule)

    if (naughties.has(pkg)) continue
    if (!(pkg in packages)) continue

    warnings.push(`Warning: Package '${pkg}' was loaded before dd-trace! This may break instrumentation.`)

    naughties.add(pkg)
    didWarn = true
  }

  if (didWarn) warnings.push('Warning: Please ensure dd-trace is loaded before other modules.')
}

/**
 * APM tools, and some other packages in the community, work
 * by monkey-patching internal modules and possibly some
 * globals. Usually this is done in a conflict-free way by
 * wrapping an existing method with a new method that still
 * calls the original method. Unfortunately it's possible
 * that some of these packages (dd-trace included) may
 * wrap methods in a way that make it unsafe for the methods
 * to be wrapped again by another library.
 *
 * When encountered, and when debug mode is on, a warning is
 * printed if such a package is discovered. This can help
 * when debugging a faulty installation.
 */
module.exports.checkForPotentialConflicts = function () {
  const naughties = new Set()
  let didWarn = false

  for (const pathToModule of Object.keys(require.cache)) {
    const { pkg } = extractPackageAndModulePath(pathToModule)
    if (naughties.has(pkg)) continue
    if (!potentialConflicts.has(pkg)) continue

    warnings.push(`Warning: Package '${pkg}' may cause conflicts with dd-trace.`)

    naughties.add(pkg)
    didWarn = true
  }

  if (didWarn) warnings.push('Warning: Packages were loaded that may conflict with dd-trace.')
}

module.exports.flushStartupLogs = function (log) {
  while (warnings.length) {
    log.warn(warnings.shift())
  }
}
