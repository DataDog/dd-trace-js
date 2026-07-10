'use strict'

// Holder for the OpenTelemetry API packages the bridge registers its providers on.
//
// The bridge must register on the exact copy the application reads with: the OTel global API
// rejects a provider registered by a copy older than the reader's and silently downgrades every
// span to a no-op (issue #6882). The holder resolves from the application entrypoint first, while
// the OpenTelemetry API instrumentations supply copies loaded through custom resolution.
//
// When no supported application copy is available, the holder falls back to dd-trace's bundled
// copy. This preserves the bridge and OTLP metrics/logs pipelines without forcing applications
// that do not use OpenTelemetry directly to add its API packages.

/** @typedef {typeof import('@opentelemetry/api')} OtelApi */
/** @typedef {typeof import('@opentelemetry/api-logs')} OtelApiLogs */

const API_VERSION_RANGE = '>=1.0.0 <1.10.0'
const API_LOGS_VERSION_RANGE = '>=0.33.0 <1.0.0'

/** @type {NodeRequire | undefined} */
let applicationRequire

/**
 * Creates a require rooted at the application entrypoint. During SSI preloading and ESM startup,
 * `require.main` is unavailable, so `process.argv[1]` identifies the entrypoint instead. Directory
 * entrypoints need a synthetic filename inside the directory or Node resolves from their parent.
 *
 * @returns {NodeRequire}
 */
function getApplicationRequire () {
  if (applicationRequire) return applicationRequire

  const { existsSync, statSync } = require('node:fs')
  const { createRequire } = require('node:module')
  const { join, resolve } = require('node:path')

  let entrypoint = require.main?.filename ?? process.argv[1]
  if (entrypoint) {
    entrypoint = resolve(entrypoint)
    if (existsSync(entrypoint) && statSync(entrypoint).isDirectory()) {
      entrypoint = join(entrypoint, 'package.json')
    }
  } else {
    entrypoint = join(process.cwd(), 'package.json')
  }

  applicationRequire = createRequire(entrypoint)
  return applicationRequire
}

/**
 * @param {string} entry
 * @param {string} packageName
 * @returns {string | undefined}
 */
function readPackageVersion (entry, packageName) {
  const { existsSync, readFileSync } = require('node:fs')
  const { dirname, join, parse } = require('node:path')

  let directory = dirname(entry)
  const { root } = parse(directory)
  while (directory !== root) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === packageName) return manifest.version
    }
    directory = dirname(directory)
  }
}

/**
 * Loads an application-owned API copy before providers register during tracer initialization.
 * Resolution happens at first use and works even when dd-trace was injected before the application
 * entrypoint. Unsupported copies stay uncaptured so the bridge keeps using its supported fallback.
 *
 * @param {string} packageName
 * @param {string} versionRange
 * @returns {object | undefined}
 */
function loadApplicationApi (packageName, versionRange) {
  let entry
  try {
    const requireFromApplication = getApplicationRequire()
    entry = requireFromApplication.resolve(packageName)
    const version = readPackageVersion(entry, packageName)
    if (!version || !require('../../../../vendor/dist/semifies')(version, versionRange)) return
    return requireFromApplication(packageName)
  } catch (error) {
    // A missing top-level package is the normal fallback case. Other resolution errors, and
    // failures after resolution, are diagnostic only: loading an optional app copy must not
    // prevent dd-trace from using its bundled copy.
    if (entry !== undefined || error?.code !== 'MODULE_NOT_FOUND') {
      require('../log').debug(
        'Unable to load the application-owned %s; using the bundled fallback.',
        packageName,
        error
      )
    }
  }
}

/**
 * Creates a holder for one OpenTelemetry API package. A fallback load is not considered an
 * application capture: requiring the fallback also runs the instrumentation synchronously, and
 * accepting that callback would prevent the application's later require from replacing it.
 *
 * @template {object} T
 * @param {string} packageName
 * @param {string} versionRange
 * @param {() => T} loadFallback
 * @returns {{ get: () => T, set: (api: T) => T }}
 */
function createApiHolder (packageName, versionRange, loadFallback) {
  /** @type {T | undefined} */
  let applicationApi
  /** @type {T | undefined} */
  let fallbackApi
  let applicationChecked = false
  let loadingFallback = false

  /**
   * @returns {T}
   */
  function load () {
    if (!applicationChecked) {
      applicationChecked = true
      const loadedApi = loadApplicationApi(packageName, versionRange)
      if (loadedApi !== undefined) {
        applicationApi = /** @type {T} */ (loadedApi)
      }
    }
    if (applicationApi !== undefined) return applicationApi

    loadingFallback = true
    try {
      fallbackApi = loadFallback()
    } finally {
      loadingFallback = false
    }
    return fallbackApi
  }

  /**
   * @returns {T}
   */
  function get () {
    // Resolve from the entrypoint before trusting a hook capture. Vendored OTel helpers also
    // require the API and can otherwise be mistaken for the application's copy.
    if (!applicationChecked) return load()
    if (applicationApi !== undefined) return applicationApi
    if (fallbackApi !== undefined) return fallbackApi
    return load()
  }

  /**
   * @param {T} api
   * @returns {T}
   */
  function set (api) {
    if (!loadingFallback && applicationApi === undefined) {
      applicationApi = api
    }
    return api
  }

  return { get, set }
}

/**
 * @returns {OtelApi}
 */
function loadApi () {
  return require('@opentelemetry/api')
}

/**
 * @returns {OtelApiLogs}
 */
function loadApiLogs () {
  return require('@opentelemetry/api-logs')
}

const apiHolder = createApiHolder('@opentelemetry/api', API_VERSION_RANGE, loadApi)
const apiLogsHolder = createApiHolder('@opentelemetry/api-logs', API_LOGS_VERSION_RANGE, loadApiLogs)

module.exports = {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
  getApi: apiHolder.get,
  getApiLogs: apiLogsHolder.get,
  setApi: apiHolder.set,
  setApiLogs: apiLogsHolder.set,
}
