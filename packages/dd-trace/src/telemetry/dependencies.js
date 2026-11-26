'use strict'

const path = require('path')
const { fileURLToPath } = require('url')
const dc = require('dc-polyfill')
const parse = require('../../../../vendor/dist/module-details-from-path')
const { getPublishedModuleLoads } = require('../esm-module-load')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')

/**
 * @typedef {{ type: string, value: string }} DependencyMetadata
 * @typedef {{ name: string, version: string, metadata?: DependencyMetadata[] }} Dependency
 */

const MAX_METADATA_ENTRIES = 100

const savedDependenciesToSend = new Map()
const detectedDependencyKeys = new Set()
const detectedDependencyVersions = new Set()
const dependencyMetadata = new Map()

const FILE_URI_START = 'file://'
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let config, application, host, initialLoad
let isFirstModule = true
let metadataEnabled = false
let getRetryData
let updateRetryData

function waitAndSend (config, application, host) {
  setImmediate(sendDependencies, config, application, host).unref?.()
}

function sendDependencies (config, application, host) {
  if (savedDependenciesToSend.size === 0) {
    return
  }
  const dependencies = []
  let send = 0
  for (const [dependency, initialLoadModule] of savedDependenciesToSend) {
    // If a dependency is from the initial load, *always* send the event
    // Otherwise, only send if dependencyCollection is enabled
    const sendModule = initialLoadModule || config.telemetry.DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED

    savedDependenciesToSend.delete(dependency)

    if (sendModule) {
      dependencies.push(createDependency(dependency))
      send++
      if (send === 2000) {
        // v2 documentation specifies up to 2000 dependencies can be sent at once
        break
      }
    }
  }

  /**
   * @type { { dependencies: typeof dependencies } | {
   *   request_type: string,
   *   payload: typeof dependencies
   * }[]}
   */
  let payload = { dependencies }
  let reqType = 'app-dependencies-loaded'
  const retryData = getRetryData()

  if (retryData) {
    payload = [{
      request_type: 'app-dependencies-loaded',
      payload,
    }, {
      request_type: retryData.reqType,
      payload: retryData.payload,
    }]
    reqType = 'message-batch'
  } else if (!dependencies.length) {
    // No retry data and no dependencies, nothing to send
    return
  }

  sendData(config, application, host, reqType, payload, updateRetryData)

  if (savedDependenciesToSend.size > 0) {
    waitAndSend(config, application, host)
  }
}

/**
 * @param {string} dependency `name version`
 * @returns {Dependency}
 */
function createDependency (dependency) {
  const [name, version] = dependency.split(' ')
  const metadata = dependencyMetadata.get(dependency) ??
    (metadataEnabled && config.telemetry.DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED ? [] : undefined)
  return metadata === undefined ? { name, version } : { name, version, metadata }
}

function enableMetadata () {
  metadataEnabled = true
}

/**
 * @param {string} name
 * @param {string} version
 * @param {DependencyMetadata[]} metadata Complete list, owned by telemetry after the call. Entries over 100 are
 *   dropped.
 */
function setDependencyMetadata (name, version, metadata) {
  if (!config?.telemetry.DD_TELEMETRY_DEPENDENCY_COLLECTION_ENABLED) {
    return
  }
  const dependency = `${name} ${version}`
  dependencyMetadata.set(
    dependency,
    metadata.length > MAX_METADATA_ENTRIES ? metadata.slice(0, MAX_METADATA_ENTRIES) : metadata
  )
  savedDependenciesToSend.set(dependency, true)
  waitAndSend(config, application, host)
}

/**
 * @param {Dependency} dependency
 * @returns {Dependency}
 */
function withCurrentMetadata (dependency) {
  const metadata = dependencyMetadata.get(`${dependency.name} ${dependency.version}`)
  return metadata === undefined || metadata === dependency.metadata ? dependency : { ...dependency, metadata }
}

/**
 * @param {{ dependencies: Dependency[] }} payload
 * @returns {{ dependencies: Dependency[] }}
 */
function refreshPayload (payload) {
  if (dependencyMetadata.size === 0) {
    return payload
  }
  return { dependencies: payload.dependencies.map(withCurrentMetadata) }
}

/**
 * @param {{ dependencies: Dependency[] }[]} failedPayloads
 * @returns {Dependency[]}
 */
function getExtendedHeartbeatDependencies (failedPayloads) {
  const dependencies = []
  const included = new Set()
  for (const payload of failedPayloads) {
    for (const dependency of payload.dependencies) {
      const key = `${dependency.name} ${dependency.version}`
      if (!included.has(key)) {
        included.add(key)
        dependencies.push(withCurrentMetadata(dependency))
      }
    }
  }
  for (const [dependency, metadata] of dependencyMetadata) {
    if (!included.has(dependency)) {
      const [name, version] = dependency.split(' ')
      dependencies.push({ name, version, metadata })
    }
  }
  return dependencies
}

function flush () {
  while (savedDependenciesToSend.size > 0) {
    sendDependencies(config, application, host)
  }
}

function loadAllTheLoadedModules () {
  if (require.cache) {
    const filenames = Object.keys(require.cache)
    for (const filename of filenames) {
      onModuleLoad({ filename })
    }
  }
  for (const filename of getPublishedModuleLoads()) {
    onModuleLoad({ filename })
  }
}

function onModuleLoad (data) {
  if (isFirstModule) {
    isFirstModule = false
    loadAllTheLoadedModules()
  }

  if (data) {
    let filename = data.filename
    if (filename?.startsWith(FILE_URI_START)) {
      try {
        filename = fileURLToPath(filename)
      } catch {
        // cannot transform url to path
      }
    }
    const parseResult = filename && parse(filename)
    const request = data.request || parseResult?.name
    const dependencyKey = parseResult?.basedir ?? request

    if (filename && request && isDependency(request) && !detectedDependencyKeys.has(dependencyKey)) {
      detectedDependencyKeys.add(dependencyKey)

      if (parseResult) {
        const { name, basedir } = parseResult
        if (basedir) {
          try {
            const { version } = requirePackageJson(basedir, module)
            const dependencyAndVersion = `${name} ${version}`

            if (!detectedDependencyVersions.has(dependencyAndVersion)) {
              savedDependenciesToSend.set(dependencyAndVersion, initialLoad)
              detectedDependencyVersions.add(dependencyAndVersion)

              waitAndSend(config, application, host)
            }
          } catch {
            // can not read the package.json, do nothing
          }
        }
      }
    }
  }
}
function start (_config = {}, _application, _host, getRetryDataFunction, updateRetryDatafunction) {
  config = _config
  application = _application
  host = _host
  initialLoad = true
  getRetryData = getRetryDataFunction
  updateRetryData = updateRetryDatafunction
  moduleLoadStartChannel.subscribe(onModuleLoad)

  // Try and capture initially loaded modules in the first tick
  // since, ideally, the tracer (and this module) should be loaded first,
  // this should capture any first-tick dependencies
  queueMicrotask(() => { initialLoad = false })
}

function isDependency (request) {
  const isDependencyWithSlash = isDependencyWithSeparator(request, '/')
  if (isDependencyWithSlash && process.platform === 'win32') {
    return isDependencyWithSeparator(request, path.sep)
  }
  return isDependencyWithSlash
}

function isDependencyWithSeparator (request, sep) {
  return request.indexOf(`..${sep}`) !== 0 &&
    request.indexOf(`.${sep}`) !== 0 &&
    request.indexOf(sep) !== 0 &&
    request.indexOf(`:${sep}`) !== 1
}

function stop () {
  config = null
  application = null
  host = null
  detectedDependencyKeys.clear()
  savedDependenciesToSend.clear()
  detectedDependencyVersions.clear()
  dependencyMetadata.clear()
  metadataEnabled = false
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.unsubscribe(onModuleLoad)
  }
}
module.exports = {
  enableMetadata,
  flush,
  getExtendedHeartbeatDependencies,
  refreshPayload,
  setDependencyMetadata,
  start,
  stop,
}
