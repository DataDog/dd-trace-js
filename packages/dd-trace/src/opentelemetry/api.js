'use strict'

const { DD_MAJOR } = require('../../../../version')
const satisfies = require('../../../../vendor/dist/semifies')
const log = require('../log')

const PACKAGE_NAME = '@opentelemetry/api'

// undefined: not resolved yet; null: resolved and absent; object: resolved api.
/** @type {typeof import('@opentelemetry/api') | null | undefined} */
let cachedApi
// Absolute path of the resolved package entrypoint, used to read its version lazily.
/** @type {string | undefined} */
let cachedEntry
let warned = false

// Node builtins are required lazily inside the helpers below rather than at module
// scope. This module is loaded from the config initialization path to answer
// `isAvailable()`, and a top-level `require('node:fs')` there trips dd-trace's own
// fs instrumentation mid-initialization, which can cascade into a circular require
// of the plugin system. Deferring the builtins keeps loading this module side-effect
// free; the filesystem read only happens later, when the bridge actually loads.

/**
 * `createRequire` rooted at the application entrypoint, used to resolve the copy
 * of `@opentelemetry/api` the user's code loads rather than dd-trace's own.
 *
 * @returns {NodeRequire | undefined}
 */
function applicationRequire () {
  const { createRequire } = require('node:module')
  // `require.main.filename` is the resolved main file; `process.argv[1]` can be a
  // directory (`node .`, `node path/to/app`), and `createRequire` rooted at a
  // directory resolves from its parent, missing the app's own node_modules.
  const entrypoint = require.main?.filename ?? process.argv[1]
  return entrypoint ? createRequire(entrypoint) : undefined
}

/**
 * @param {NodeRequire} req
 * @returns {{ api: typeof import('@opentelemetry/api'), entry: string } | undefined}
 */
function resolveFrom (req) {
  try {
    return { api: req(PACKAGE_NAME), entry: req.resolve(PACKAGE_NAME) }
  } catch {}
}

/**
 * @returns {{ api: typeof import('@opentelemetry/api'), entry: string } | undefined}
 */
function resolveApi () {
  // v6 declares @opentelemetry/api as an optional peer dependency, so a single
  // shared copy lives in the application and dd-trace's own require resolves it.
  if (DD_MAJOR >= 6) {
    return resolveFrom(require)
  }
  // v5 bundles @opentelemetry/api as an optional dependency, so dd-trace's own
  // require can resolve its bundled (older) copy instead of the application's.
  // The OTel global API rejects a provider registered by a copy older than the
  // reader's, which silently downgrades every span to a no-op (issue #6882).
  // Prefer the application's copy and fall back to dd-trace's bundled one.
  const appRequire = applicationRequire()
  return (appRequire && resolveFrom(appRequire)) || resolveFrom(require)
}

function ensureResolved () {
  if (cachedApi !== undefined) return
  const resolved = resolveApi()
  cachedApi = resolved?.api ?? null
  cachedEntry = resolved?.entry
}

/**
 * Reads the package version by walking up from the resolved entrypoint. The
 * package blocks `require('@opentelemetry/api/package.json')` through its
 * `exports` map, so the version is read from disk instead. `require-package-json`
 * resolves against a module's `module.paths`, which on v5 points at dd-trace's copy
 * rather than the application copy this entrypoint was resolved from, so it cannot
 * answer "which copy did we share"; the walk anchors on the resolved entry instead.
 *
 * @param {string} entry - Absolute path to the resolved package entrypoint.
 * @returns {string | undefined}
 */
function readVersionNear (entry) {
  const { readFileSync } = require('node:fs')
  const { dirname, join, parse } = require('node:path')
  let dir = dirname(entry)
  const { root } = parse(dir)
  while (dir !== root) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === PACKAGE_NAME) return pkg.version
    } catch {}
    dir = dirname(dir)
  }
}

/**
 * Warns when the resolved version is outside dd-trace's declared range, read from
 * dd-trace's own package.json so the threshold stays in lockstep with the declaration.
 *
 * @param {string | undefined} version - Resolved `@opentelemetry/api` version.
 */
function warnIfUnsupported (version) {
  const pkg = require('../../../../package.json')
  const range = pkg.peerDependencies?.[PACKAGE_NAME] ?? pkg.optionalDependencies?.[PACKAGE_NAME]
  if (version && range && !satisfies(version, range)) {
    log.warn(
      '@opentelemetry/api@%s is outside the range dd-trace supports (%s); OpenTelemetry spans may run as no-ops.',
      version, range
    )
  }
}

/**
 * Returns the `@opentelemetry/api` the bridge must share with the application,
 * throwing a clear error when it is not installed. The first successful load
 * warns once if the resolved version is outside dd-trace's supported range.
 *
 * @returns {typeof import('@opentelemetry/api')}
 */
function load () {
  ensureResolved()
  if (cachedApi === null) {
    throw new Error(
      `${PACKAGE_NAME} is not installed but is required to use the OpenTelemetry bridge ` +
      '(tracer.TracerProvider). Add it as a dependency of your application to enable the bridge.'
    )
  }
  if (!warned) {
    warned = true
    warnIfUnsupported(cachedEntry && readVersionNear(cachedEntry))
  }
  return cachedApi
}

/**
 * Whether `@opentelemetry/api` can be resolved. Kept free of filesystem access so
 * it is safe to call from the config initialization path.
 *
 * @returns {boolean}
 */
function isAvailable () {
  ensureResolved()
  return cachedApi !== null
}

module.exports = { load, isAvailable }
