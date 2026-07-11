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
/**
 * @typedef {object} HookMetadata
 * @property {string} [moduleBaseDir]
 * @property {boolean} [applicationOwned]
 */
/**
 * @template T
 * @typedef {object} ApiBinding
 * @property {T} current
 */
/**
 * @template T
 * @typedef {object} ApiRegistration
 * @property {(api: T) => void} activate
 * @property {(api: T) => void} deactivate
 */
/**
 * @typedef {object} ApplicationLocation
 * @property {string} entrypoint
 * @property {string} root
 */
/**
 * @typedef {object} CapturePriority
 * @property {number} rootIndex
 * @property {number} depth
 */

const API_VERSION_RANGE = '>=1.0.0 <1.10.0'
const API_LOGS_VERSION_RANGE = '>=0.33.0 <1.0.0'

/** @type {ApplicationLocation[] | undefined} */
let applicationLocations
/** @type {NodeRequire[] | undefined} */
let applicationRequires

/**
 * Returns resolution locations ordered by ownership. A nested entrypoint comes first so its
 * dependency wins in a workspace, while the working directory stays authoritative when an external
 * CLI launches the application.
 *
 * @returns {ApplicationLocation[]}
 */
function getApplicationLocations () {
  if (applicationLocations) return applicationLocations

  const { existsSync, statSync } = require('node:fs')
  const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')

  const workingDirectory = process.cwd()
  const workingDirectoryLocation = {
    entrypoint: join(workingDirectory, 'package.json'),
    root: workingDirectory,
  }
  const locations = []
  let entrypoint = require.main?.filename ?? process.argv[1]
  if (entrypoint) {
    entrypoint = resolve(entrypoint)
    let entrypointRoot = dirname(entrypoint)
    if (existsSync(entrypoint) && statSync(entrypoint).isDirectory()) {
      entrypointRoot = entrypoint
      entrypoint = join(entrypoint, 'package.json')
    }
    const pathFromWorkingDirectory = relative(workingDirectory, entrypoint)
    const isNestedEntrypoint = pathFromWorkingDirectory !== '..' &&
      !pathFromWorkingDirectory.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromWorkingDirectory)
    const entrypointLocation = { entrypoint, root: entrypointRoot }
    if (isNestedEntrypoint && entrypointRoot !== workingDirectory) locations.push(entrypointLocation)
    locations.push(workingDirectoryLocation)
    if (!isNestedEntrypoint && entrypointRoot !== workingDirectory) locations.push(entrypointLocation)
  } else {
    locations.push(workingDirectoryLocation)
  }

  applicationLocations = locations
  return applicationLocations
}

/**
 * Creates requires rooted at each application resolution location.
 *
 * @returns {NodeRequire[]}
 */
function getApplicationRequires () {
  if (applicationRequires) return applicationRequires

  const { createRequire } = require('node:module')
  applicationRequires = getApplicationLocations().map(({ entrypoint }) => createRequire(entrypoint))
  return applicationRequires
}

/**
 * @param {string} entry
 * @param {string} packageName
 * @returns {{ version: string, moduleBaseDir: string } | undefined}
 */
function readPackageMetadata (entry, packageName) {
  const { existsSync, readFileSync } = require('node:fs')
  const { dirname, join, parse } = require('node:path')

  let directory = dirname(entry)
  const { root } = parse(directory)
  while (directory !== root) {
    const manifestPath = join(directory, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest.name === packageName && typeof manifest.version === 'string') {
        return { version: manifest.version, moduleBaseDir: directory }
      }
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
 * @returns {{ api: object, priority: CapturePriority, version: string } | undefined}
 */
function loadApplicationApi (packageName, versionRange) {
  for (const requireFromApplication of getApplicationRequires()) {
    let entry
    try {
      entry = requireFromApplication.resolve(packageName)
      const metadata = readPackageMetadata(entry, packageName)
      if (!metadata) continue
      if (!require('../../../../vendor/dist/semifies')(metadata.version, versionRange)) {
        require('../log').warn(
          'Unsupported application-owned %s@%s; supported versions are %s. Using the bundled fallback.',
          packageName,
          metadata.version,
          versionRange
        )
        return
      }
      return {
        api: requireFromApplication(packageName),
        priority: capturePriority({ moduleBaseDir: metadata.moduleBaseDir }),
        version: metadata.version,
      }
    } catch (error) {
      if (entry !== undefined || error?.code !== 'MODULE_NOT_FOUND') {
        require('../log').debug(
          'Unable to load the application-owned %s; using the bundled fallback.',
          packageName,
          error
        )
        return
      }
    }
  }
}

/**
 * @param {HookMetadata | undefined} hookMetadata
 * @returns {CapturePriority}
 */
function capturePriority (hookMetadata) {
  if (hookMetadata?.applicationOwned === true) return { rootIndex: -1, depth: 0 }
  if (!hookMetadata?.moduleBaseDir) {
    return { rootIndex: Number.MAX_SAFE_INTEGER, depth: Number.MAX_SAFE_INTEGER }
  }

  const { isAbsolute, relative, sep } = require('node:path')
  const locations = getApplicationLocations()

  for (let rootIndex = 0; rootIndex < locations.length; rootIndex++) {
    const { root } = locations[rootIndex]
    const pathFromRoot = relative(root, hookMetadata.moduleBaseDir)
    if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) continue
    return { rootIndex, depth: pathFromRoot.split(sep).length }
  }
  return { rootIndex: Number.MAX_SAFE_INTEGER, depth: Number.MAX_SAFE_INTEGER }
}

/**
 * @param {CapturePriority} candidate
 * @param {CapturePriority} current
 * @returns {boolean}
 */
function hasHigherPriority (candidate, current) {
  return candidate.rootIndex < current.rootIndex ||
    (candidate.rootIndex === current.rootIndex && candidate.depth < current.depth)
}

/**
 * @param {string} packageName
 * @param {string | undefined} version
 */
function prepareGlobalRegistration (packageName, version) {
  if (packageName !== '@opentelemetry/api' || !version) return

  const major = version.slice(0, version.indexOf('.'))
  const globalApi = Reflect.get(globalThis, Symbol.for(`opentelemetry.js.api.${major}`))
  if (!globalApi || typeof globalApi !== 'object' || globalApi.version === version) return

  // disable() removes providers but leaves the core API's global version behind. Transfer that
  // container before the new copy registers or it rejects every provider with a version mismatch.
  try {
    globalApi.version = version
  } catch (error) {
    require('../log').error('Unable to transfer the OpenTelemetry API global to version %s.', version, error)
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
 * @returns {{
 *   binding: () => ApiBinding<T>,
 *   finalize: () => T,
 *   get: () => T,
 *   register: (registration: ApiRegistration<T>) => void,
 *   set: (api: T, version?: string, isIitm?: boolean, hookMetadata?: HookMetadata) => T
 * }}
 */
function createApiHolder (packageName, versionRange, loadFallback) {
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let applicationCapture
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let captured
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let fallback
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let finalized
  /** @type {ApiBinding<T> | undefined} */
  let binding
  /** @type {Set<ApiRegistration<T>>} */
  const registrations = new Set()
  let applicationChecked = false
  let loadingFallback = false

  /**
   * @returns {{ api: T, priority: CapturePriority, version?: string }}
   */
  function select () {
    if (finalized) return finalized

    if (!applicationChecked) {
      applicationChecked = true
      const loaded = loadApplicationApi(packageName, versionRange)
      if (loaded) {
        applicationCapture = {
          api: /** @type {T} */ (loaded.api),
          priority: loaded.priority,
          version: loaded.version,
        }
      }
    }
    if (applicationCapture) return applicationCapture
    if (captured) return captured
    if (fallback) return fallback

    loadingFallback = true
    try {
      fallback = {
        api: loadFallback(),
        priority: { rootIndex: Number.MAX_SAFE_INTEGER, depth: Number.MAX_SAFE_INTEGER },
      }
    } finally {
      loadingFallback = false
    }
    return fallback
  }

  /**
   * @returns {T}
   */
  function get () {
    return select().api
  }

  /**
   * @returns {T}
   */
  function finalize () {
    finalized = select()
    return finalized.api
  }

  /**
   * @returns {ApiBinding<T>}
   */
  function getBinding () {
    if (!binding) binding = { current: finalize() }
    return binding
  }

  /**
   * @param {{ api: T, priority: CapturePriority, version?: string }} candidate
   */
  function transition (candidate) {
    const previous = finalized
    const currentRegistrations = [...registrations]

    for (const registration of currentRegistrations) {
      try {
        registration.deactivate(previous.api)
      } catch (error) {
        require('../log').error('Error deactivating the previous %s registration.', packageName, error)
      }
    }

    prepareGlobalRegistration(packageName, candidate.version)
    finalized = candidate
    if (binding) binding.current = candidate.api

    for (const registration of currentRegistrations) {
      try {
        registration.activate(candidate.api)
      } catch (error) {
        require('../log').error('Error activating the new %s registration.', packageName, error)
      }
    }
  }

  /**
   * @param {ApiRegistration<T>} registration
   */
  function register (registration) {
    registrations.add(registration)
    registration.activate(finalize())
  }

  /**
   * @param {T} api
   * @param {string} [version]
   * @param {boolean} [_isIitm]
   * @param {HookMetadata} [hookMetadata]
   * @returns {T}
   */
  function set (api, version, _isIitm, hookMetadata) {
    if (loadingFallback || hookMetadata?.applicationOwned === false) return api

    const candidate = { api, priority: capturePriority(hookMetadata), version }
    if (finalized) {
      if (hasHigherPriority(candidate.priority, finalized.priority)) {
        captured = candidate
        if (api === finalized.api) {
          finalized = candidate
        } else {
          transition(candidate)
        }
      }
      return api
    }

    if (!captured || hasHigherPriority(candidate.priority, captured.priority)) {
      captured = candidate
    }
    return api
  }

  return { binding: getBinding, finalize, get, register, set }
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
  finalizeApi: apiHolder.finalize,
  getApi: apiHolder.get,
  getApiBinding: apiHolder.binding,
  getApiLogs: apiLogsHolder.get,
  registerApi: apiHolder.register,
  registerApiLogs: apiLogsHolder.register,
  setApi: apiHolder.set,
  setApiLogs: apiLogsHolder.set,
}
