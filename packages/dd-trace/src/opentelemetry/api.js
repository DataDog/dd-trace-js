'use strict'

// Holder for the OpenTelemetry API packages used by the bridge.
//
// Providers register once through dd-trace's compatibility-max fallback. Older application copies
// can consume globals owned by that newer copy, while moving registrations between exact versions is
// unsafe because the core API keeps its original version sentinel after disable() (issue #6882).
//
// Copy-local bridge operations use one immutable snapshot. A later application capture replaces
// the whole snapshot with one pointer assignment without disturbing registered providers.

/** @typedef {typeof import('@opentelemetry/api')} OtelApi */
/** @typedef {typeof import('@opentelemetry/api-logs')} OtelApiLogs */
/**
 * @typedef {object} HookMetadata
 * @property {string} [moduleBaseDir]
 * @property {boolean} [applicationOwned]
 */
/**
 * @typedef {object} ApiSnapshot
 * @property {OtelApi} api
 * @property {OtelApiLogs} [apiLogs]
 */
/**
 * @typedef {object} ApiBinding
 * @property {ApiSnapshot} current
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
const API_OWNER_VERSION = require('../../../../package.json').dependencies['@opentelemetry/api']

/** @type {ApplicationLocation[] | undefined} */
let applicationLocations
/** @type {NodeRequire[] | undefined} */
let applicationRequires

function prepareApiOwner () {
  const globalKey = Symbol.for('opentelemetry.js.api.1')
  try {
    const globalApi = Reflect.get(globalThis, globalKey)
    if (!globalApi || typeof globalApi !== 'object' || globalApi.version === API_OWNER_VERSION) return
    if (typeof globalApi.version !== 'string') return
    if (!require('../../../../vendor/dist/semifies')(globalApi.version, API_VERSION_RANGE)) return

    for (const key of Reflect.ownKeys(globalApi)) {
      if (key !== 'version' && key !== 'diag') return
    }

    // A diagnostic logger creates the core global before any signal owns it. Move that diagnostic
    // state to the newer compatible owner once so every supported API copy can consume later signals.
    const ownerGlobal = { ...globalApi, version: API_OWNER_VERSION }
    if (!Reflect.set(globalThis, globalKey, ownerGlobal)) {
      require('../log').error('Unable to prepare the OpenTelemetry API global owner.')
    }
  } catch (error) {
    require('../log').error('Unable to prepare the OpenTelemetry API global owner: %s', error)
  }
}

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
 * Creates a holder for one OpenTelemetry API package. A fallback load is not considered an
 * application capture: requiring the fallback also runs the instrumentation synchronously, and
 * accepting that callback would prevent the application's later require from replacing it.
 *
 * @template {object} T
 * @param {string} packageName
 * @param {string} versionRange
 * @param {() => T} loadFallback
 * @param {(api: T) => void} promote
 * @param {() => void} [prepareOwner]
 * @returns {{
 *   finalize: () => T,
 *   get: () => T,
 *   owner: () => T,
 *   set: (api: T, version?: string, isIitm?: boolean, hookMetadata?: HookMetadata) => T
 * }}
 */
function createApiHolder (packageName, versionRange, loadFallback, promote, prepareOwner) {
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let applicationCapture
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let captured
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let fallback
  /** @type {{ api: T, priority: CapturePriority, version?: string } | undefined} */
  let finalized
  let applicationChecked = false
  let loadingFallback = false

  /**
   * @returns {{ api: T, priority: CapturePriority, version?: string }}
   */
  function owner () {
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
    return owner()
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
   * @returns {T}
   */
  function getOwner () {
    const api = owner().api
    prepareOwner?.()
    return api
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
        const changed = api !== finalized.api
        finalized = candidate
        if (changed) promote(api)
      }
      return api
    }

    if (!captured || hasHigherPriority(candidate.priority, captured.priority)) {
      captured = candidate
    }
    return api
  }

  return { finalize, get, owner: getOwner, set }
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

/** @type {ApiBinding | undefined} */
let apiBinding

/**
 * @param {OtelApi} api
 */
function promoteApi (api) {
  if (apiBinding) apiBinding.current = { api, apiLogs: apiBinding.current.apiLogs }
}

/**
 * @param {OtelApiLogs} apiLogs
 */
function promoteApiLogs (apiLogs) {
  if (apiBinding) apiBinding.current = { api: apiBinding.current.api, apiLogs }
}

const apiHolder = createApiHolder('@opentelemetry/api', API_VERSION_RANGE, loadApi, promoteApi, prepareApiOwner)
const apiLogsHolder = createApiHolder('@opentelemetry/api-logs', API_LOGS_VERSION_RANGE, loadApiLogs, promoteApiLogs)

/**
 * @returns {ApiBinding}
 */
function getApiBinding () {
  if (!apiBinding) {
    apiBinding = {
      current: {
        api: apiHolder.finalize(),
      },
    }
  }
  return apiBinding
}

/**
 * @returns {ApiBinding}
 */
function getApiLogsBinding () {
  const binding = getApiBinding()
  if (!binding.current.apiLogs) {
    binding.current = {
      api: binding.current.api,
      apiLogs: apiLogsHolder.finalize(),
    }
  }
  return binding
}

module.exports = {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
  getApi: apiHolder.get,
  getApiBinding,
  getApiLogs: apiLogsHolder.get,
  getApiLogsBinding,
  getApiLogsOwner: apiLogsHolder.owner,
  getApiOwner: apiHolder.owner,
  setApi: apiHolder.set,
  setApiLogs: apiLogsHolder.set,
}
