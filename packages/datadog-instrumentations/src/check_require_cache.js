'use strict'

/* eslint-disable no-console */

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
 * `http`.
 *
 * The output isn't necessarily 100% perfect. For example if the
 * app loads a package we instrument but outside of an
 * unsupported version then a warning would still be displayed.
 * This is OK as the tracer should be loaded earlier anyway.
 */
module.exports = function () {
  const packages = require('../../datadog-instrumentations/src/helpers/hooks')
  const naughties = new Set()
  let didWarn = false

  for (const pathToModule of Object.keys(require.cache)) {
    const { pkg } = extractPackageAndModulePath(pathToModule)

    if (naughties.has(pkg)) continue
    if (!(pkg in packages)) continue

    console.error(`Warning: Package '${pkg}' was loaded before dd-trace! This may break instrumentation.`)

    naughties.add(pkg)
    didWarn = true
  }

  if (didWarn) console.error('Warning: Please ensure dd-trace is loaded before other modules.')
}
