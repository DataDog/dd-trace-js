'use strict'

const { isAbsolute, relative, resolve, sep } = require('node:path')

const satisfies = require('../../../../vendor/dist/semifies')
const log = require('../log')

/** @typedef {typeof import('@opentelemetry/api')} OtelApi */
/** @typedef {typeof import('@opentelemetry/api-logs')} OtelApiLogs */
/** @typedef {{ current: OtelApi }} ApiBinding */
/**
 * @typedef {object} HookMetadata
 * @property {string} [moduleBaseDir]
 */

const API_VERSION_RANGE = '>=1.4.1 <1.10.0'
const API_LOGS_VERSION_RANGE = '>=0.33.0 <1.0.0'
const DEFAULT_API_OWNER_VERSION = require('../../../../package.json').optionalDependencies['@opentelemetry/api']
const DD_TRACE_DIRECTORY = resolve(__dirname, '../../../..')

/**
 * Moves diagnostic-only state to the pinned API version before it owns a signal.
 *
 * OpenTelemetry requires every signal registration to use the exact version that created the
 * global. An older application copy can create that global by configuring diagnostics alone,
 * even though a newer owner would otherwise be backwards compatible.
 *
 * @param {string} ownerVersion
 */
function prepareApiOwner (ownerVersion) {
  const globalKey = Symbol.for('opentelemetry.js.api.1')

  try {
    const globalApi = Reflect.get(globalThis, globalKey)
    if (!globalApi || typeof globalApi !== 'object' || globalApi.version === ownerVersion) return
    if (typeof globalApi.version !== 'string' || !satisfies(globalApi.version, API_VERSION_RANGE)) return

    for (const key of Reflect.ownKeys(globalApi)) {
      if (key !== 'version' && key !== 'diag') return
    }

    const ownerGlobal = { ...globalApi, version: ownerVersion }
    if (!Reflect.set(globalThis, globalKey, ownerGlobal)) {
      log.error('Unable to prepare the OpenTelemetry API global owner.')
    }
  } catch (error) {
    log.error('Unable to prepare the OpenTelemetry API global owner: %s', error)
  }
}

/**
 * @param {HookMetadata | undefined} hookMetadata
 * @returns {boolean}
 */
function isInternalApi (hookMetadata) {
  if (!hookMetadata?.moduleBaseDir) return false

  const pathFromRoot = relative(DD_TRACE_DIRECTORY, hookMetadata.moduleBaseDir)
  return pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot)
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
 * @template {object} T
 * @param {string} packageName
 * @param {string} versionRange
 * @returns {T | undefined}
 */
function loadApplicationApi (packageName, versionRange) {
  const { existsSync, statSync } = require('node:fs')
  const { createRequire } = require('node:module')
  const { join } = require('node:path')

  let entrypoint = require.main?.filename ?? process.argv[1]
  if (entrypoint && existsSync(entrypoint) && statSync(entrypoint).isDirectory()) {
    entrypoint = join(entrypoint, 'package.json')
  }
  entrypoint ??= join(process.cwd(), 'package.json')

  let entry
  try {
    const applicationRequire = createRequire(resolve(entrypoint))
    entry = applicationRequire.resolve(packageName)
    const version = readPackageVersion(entry, packageName)
    if (typeof version !== 'string') return
    if (!satisfies(version, versionRange)) {
      log.warn(
        'Unsupported application-owned %s@%s; supported versions are %s. Using the bundled fallback.',
        packageName,
        version,
        versionRange
      )
      return
    }
    return applicationRequire(packageName)
  } catch (error) {
    if (entry !== undefined || error?.code !== 'MODULE_NOT_FOUND') {
      log.debug('Unable to load the application-owned %s: %s', packageName, error)
    }
  }
}

/**
 * @template {object} T
 * @param {string} packageName
 * @param {string} versionRange
 * @param {() => T} loadOwner
 */
function createApiHolder (packageName, versionRange, loadOwner) {
  /** @type {T | undefined} */
  let captured
  /** @type {T | undefined} */
  let owner
  let ownerVersion
  /** @type {{ current: T } | undefined} */
  let binding
  let applicationChecked = false
  let loadingOwner = false

  function getOwner () {
    if (owner === undefined) {
      loadingOwner = true
      try {
        owner = loadOwner()
      } finally {
        loadingOwner = false
      }
    }
    return owner
  }

  function get () {
    if (!applicationChecked) {
      applicationChecked = true
      captured ??= loadApplicationApi(packageName, versionRange)
    }
    return captured ?? getOwner()
  }

  function getBinding () {
    binding ??= { current: get() }
    return binding
  }

  /**
   * @param {T} api
   * @param {string} [_version]
   * @param {boolean} [_isIitm]
   * @param {HookMetadata} [hookMetadata]
   */
  function set (api, _version, _isIitm, hookMetadata) {
    if (loadingOwner) {
      ownerVersion = _version
      return api
    }

    if (captured === undefined && !isInternalApi(hookMetadata) && api !== getOwner()) {
      captured = api
      if (binding) binding.current = api
    }
    return api
  }

  return { get, getBinding, getOwner, getOwnerVersion: () => ownerVersion, set }
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

/**
 * Returns the pinned API after making it safe to register global signal providers.
 *
 * @returns {OtelApi}
 */
function getApiOwner () {
  const owner = apiHolder.getOwner()
  prepareApiOwner(apiHolder.getOwnerVersion() ?? DEFAULT_API_OWNER_VERSION)
  return owner
}

module.exports = {
  API_LOGS_VERSION_RANGE,
  API_VERSION_RANGE,
  getApi: apiHolder.get,
  getApiBinding: apiHolder.getBinding,
  getApiLogs: apiLogsHolder.get,
  getApiLogsOwner: apiLogsHolder.getOwner,
  getApiOwner,
  setApi: apiHolder.set,
  setApiLogs: apiLogsHolder.set,
}
