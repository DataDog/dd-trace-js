'use strict'

// This code runs before the tracer is configured and before a logger is ready
// For that reason we queue up the messages now and decide what to do with them later
const warnings = []
// Same idea, but for the high-signal framework warnings that surface by default
// (see flushFrameworkWarnings) rather than only under DD_TRACE_DEBUG.
const frameworkWarnings = []

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
  'sqreen',
])

const extractPackageAndModulePath = require('./extract-package-and-module-path')

/**
 * Frameworks that load their own server code before any user code (and thus
 * before a late `tracer.init()`) can run. When their server module is already
 * in `require.cache` at init time, dd-trace was loaded too late to instrument
 * them and the integration silently no-ops. Unlike the broad scan below, this
 * set is high-signal enough to warn on by default. `file` is the module whose
 * presence proves the server is already loaded; `guidance` is the bundler note
 * appended to the warning.
 */
const earlyLoadFrameworks = new Map([
  ['next', {
    // dist/server/next-server.js (>=11.1), dist/next-server/server/next-server.js (older)
    file: 'next-server.js',
    guidance: "add 'dd-trace' to `serverExternalPackages` (Next.js >=15) or " +
      '`experimental.serverComponentsExternalPackages` (13-14) so it is not bundled',
  }],
])

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
 *
 * Curated frameworks (see `earlyLoadFrameworks`) are collected regardless of
 * `debug`, since they surface by default; the broad list stays debug-only.
 * @param {boolean} debug Whether to also queue the broad DD_TRACE_DEBUG-only warnings.
 */
module.exports.checkForRequiredModules = function (debug) {
  const packages = require('./hooks')
  const naughties = new Set()
  const frameworksSeen = new Set()
  let didWarn = false

  for (const pathToModule of Object.keys(require.cache)) {
    // require.cache keys use the platform separator; normalize so the
    // `node_modules/<pkg>` parsing works on Windows (backslash paths).
    const { pkg, path } = extractPackageAndModulePath(pathToModule.replaceAll('\\', '/'))

    if (pkg === null) continue

    // A curated framework loads its own server before user code, so its server
    // module being cached means dd-trace was too late to instrument it. These
    // surface by default (see flushFrameworkWarnings) with an actionable
    // message, so they never fall through to the DD_TRACE_DEBUG-only list below.
    const framework = earlyLoadFrameworks.get(pkg)
    if (framework !== undefined) {
      if (!frameworksSeen.has(pkg) && path?.endsWith(framework.file)) {
        frameworksSeen.add(pkg)
        frameworkWarnings.push(
          `'${pkg}' was loaded before dd-trace, so the ${pkg} integration will not be applied. ` +
          'Initialize dd-trace before your application starts — ' +
          "NODE_OPTIONS='--require dd-trace/init' (CommonJS) or '--import dd-trace/initialize.mjs' (ESM) — " +
          `and ${framework.guidance}.`
        )
      }
      continue
    }

    if (!debug || naughties.has(pkg) || !(pkg in packages)) continue

    warnings.push(() => `Warning: Package '${pkg}' was loaded before dd-trace! This may break instrumentation.`)

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

    warnings.push(() => `Warning: Package '${pkg}' may cause conflicts with dd-trace.`)

    naughties.add(pkg)
    didWarn = true
  }

  if (didWarn) warnings.push('Warning: Packages were loaded that may conflict with dd-trace.')
}

module.exports.flushStartupLogs = function (log) {
  // Some callers pass `./log/writer` (simple pass-through) while others pass the main `./log`
  // module (which supports lazy delegate functions). Invoke closures here so both work.
  while (warnings.length) {
    const entry = warnings.shift()
    log.warn(typeof entry === 'function' ? entry() : entry)
  }
}

/**
 * Drains the framework warnings collected by `checkForRequiredModules`. The
 * tracer surfaces these unconditionally (not gated on startupLogs or
 * DD_TRACE_DEBUG), unlike the DD_TRACE_DEBUG-only `flushStartupLogs` queue,
 * because the affected users run with neither enabled (#5430 / #5432).
 * @param {(message: string) => void} warn
 */
module.exports.flushFrameworkWarnings = function (warn) {
  while (frameworkWarnings.length) {
    warn(frameworkWarnings.shift())
  }
}
