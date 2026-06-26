'use strict'

const { DD_MAJOR } = require('../../../../version')
const satisfies = require('../../../../vendor/dist/semifies')
const log = require('../log')

// The consequence of resolving an unsupported version differs per package: an
// out-of-range @opentelemetry/api silently downgrades spans to no-ops (issue #6882),
// while @opentelemetry/api-logs only drops the records it cannot serialize.
const UNSUPPORTED_CONSEQUENCE = {
  '@opentelemetry/api': 'OpenTelemetry spans may run as no-ops.',
  '@opentelemetry/api-logs': 'OpenTelemetry log records may be dropped.',
}

// Node builtins are required lazily inside the helpers below rather than at module
// scope. This module is loaded from the config initialization path to answer
// `isAvailable()`, and a top-level `require('node:fs')` there trips dd-trace's own
// fs instrumentation mid-initialization, which can cascade into a circular require
// of the plugin system. Deferring the builtins keeps loading this module side-effect
// free; the filesystem read only happens later, when the bridge actually loads.

/**
 * `createRequire` rooted at the application entrypoint, used to resolve the copy
 * of the package the user's code loads rather than dd-trace's own.
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
 * @param {string} packageName
 * @returns {{ api: object, entry: string } | undefined}
 */
function resolveFrom (req, packageName) {
  try {
    return { api: req(packageName), entry: req.resolve(packageName) }
  } catch {}
}

/**
 * @param {string} packageName
 * @returns {{ api: object, entry: string } | undefined}
 */
function resolveApi (packageName) {
  // v6 declares the OpenTelemetry API packages as optional peer dependencies, so a
  // single shared copy lives in the application and dd-trace's own require resolves it.
  if (DD_MAJOR >= 6) {
    return resolveFrom(require, packageName)
  }
  // v5 bundles the OpenTelemetry API packages as optional dependencies, so dd-trace's
  // own require can resolve its bundled (older) copy instead of the application's. The
  // OTel global API rejects a provider registered by a copy older than the reader's,
  // which silently downgrades every span to a no-op (issue #6882). Prefer the
  // application's copy and fall back to dd-trace's bundled one.
  const appRequire = applicationRequire()
  return (appRequire && resolveFrom(appRequire, packageName)) || resolveFrom(require, packageName)
}

/**
 * Reads the package version by walking up from the resolved entrypoint. The
 * package blocks `require('<pkg>/package.json')` through its `exports` map, so the
 * version is read from disk instead. `require-package-json` resolves against a
 * module's `module.paths`, which on v5 points at dd-trace's copy rather than the
 * application copy this entrypoint was resolved from, so it cannot answer "which
 * copy did we share"; the walk anchors on the resolved entry instead.
 *
 * @param {string} entry - Absolute path to the resolved package entrypoint.
 * @param {string} packageName
 * @returns {string | undefined}
 */
function readVersionNear (entry, packageName) {
  const { readFileSync } = require('node:fs')
  const { dirname, join, parse } = require('node:path')
  let dir = dirname(entry)
  const { root } = parse(dir)
  while (dir !== root) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      if (pkg.name === packageName) return pkg.version
    } catch {}
    dir = dirname(dir)
  }
}

/**
 * Warns when the resolved version is outside dd-trace's declared range, read from
 * dd-trace's own package.json so the threshold stays in lockstep with the declaration.
 *
 * @param {string} packageName
 * @param {string | undefined} version - Resolved package version.
 */
function warnIfUnsupported (packageName, version) {
  const pkg = require('../../../../package.json')
  const range = pkg.peerDependencies?.[packageName] ?? pkg.optionalDependencies?.[packageName]
  if (version && range && !satisfies(version, range)) {
    log.warn(
      '%s@%s is outside the range dd-trace supports (%s); %s',
      packageName, version, range, UNSUPPORTED_CONSEQUENCE[packageName]
    )
  }
}

/**
 * Builds a loader that shares a single copy of an OpenTelemetry API package between
 * dd-trace and the application. Each package gets its own cached state so resolution
 * and the once-only version warning stay independent.
 *
 * @param {string} packageName - The package to resolve (e.g. `@opentelemetry/api`).
 * @returns {{ load: () => object, isAvailable: () => boolean }}
 */
function createLoader (packageName) {
  // undefined: not resolved yet; null: resolved and absent; object: resolved api.
  /** @type {object | null | undefined} */
  let cachedApi
  // Absolute path of the resolved package entrypoint, used to read its version lazily.
  /** @type {string | undefined} */
  let cachedEntry
  let warned = false

  function ensureResolved () {
    if (cachedApi !== undefined) return
    const resolved = resolveApi(packageName)
    cachedApi = resolved?.api ?? null
    cachedEntry = resolved?.entry
  }

  return {
    /**
     * Returns the package the bridge must share with the application, throwing a clear
     * error when it is not installed. The first successful load warns once if the
     * resolved version is outside dd-trace's supported range.
     *
     * @returns {object}
     */
    load () {
      ensureResolved()
      if (cachedApi === null) {
        throw new Error(
          `${packageName} is not installed but is required to use the OpenTelemetry bridge ` +
          '(tracer.TracerProvider). Add it as a dependency of your application to enable the bridge.'
        )
      }
      if (!warned) {
        warned = true
        warnIfUnsupported(packageName, cachedEntry && readVersionNear(cachedEntry, packageName))
      }
      return cachedApi
    },

    /**
     * Whether the package can be resolved. Kept free of filesystem access so it is
     * safe to call from the config initialization path.
     *
     * @returns {boolean}
     */
    isAvailable () {
      ensureResolved()
      return cachedApi !== null
    },
  }
}

const apiLoader = createLoader('@opentelemetry/api')
const loaders = new Map([['@opentelemetry/api', apiLoader]])

/**
 * Returns the shared loader for an OpenTelemetry API package, reusing the cached
 * loader so every consumer of a package shares one resolution and one warning.
 *
 * @param {string} packageName
 * @returns {{ load: () => object, isAvailable: () => boolean }}
 */
function forPackage (packageName) {
  let loader = loaders.get(packageName)
  if (!loader) {
    loader = createLoader(packageName)
    loaders.set(packageName, loader)
  }
  return loader
}

module.exports = { load: apiLoader.load, isAvailable: apiLoader.isAvailable, forPackage }
