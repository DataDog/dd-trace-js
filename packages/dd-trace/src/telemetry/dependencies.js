'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('dc-polyfill')
const { fileURLToPath } = require('url')
const { isTrue } = require('../../src/util')

/** @type {Set<string>} */
const savedDependenciesToSend = new Set()
const detectedDependencyKeys = new Set()
const detectedDependencyVersions = new Set()

const FILE_URI_START = 'file://'
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let config, application, host, initialLoad
let isFirstModule = true
let getRetryData
let updateRetryData

function waitAndSend (config, application, host) {
  setImmediate(() => {
    if (savedDependenciesToSend.size === 0) {
      return
    }
    const dependencies = []
    let send = 0
    for (const dependency of savedDependenciesToSend) {
      const [name, version, initialLoadModule] = dependency.split(' ')
      // If a dependency is from the initial load, *always* send the event
      // Otherwise, only send if dependencyCollection is enabled
      const sendModule = isTrue(initialLoadModule) || config.telemetry?.dependencyCollection

      savedDependenciesToSend.delete(dependency)

      if (sendModule) {
        dependencies.push({ name, version })
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
        payload
      }, {
        request_type: retryData.reqType,
        payload: retryData.payload
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
  }).unref()
}

function loadAllTheLoadedModules () {
  if (require.cache) {
    const filenames = Object.keys(require.cache)
    filenames.forEach(filename => {
      onModuleLoad({ filename })
    })
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
              savedDependenciesToSend.add(`${dependencyAndVersion} ${initialLoad}`)
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
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.unsubscribe(onModuleLoad)
  }
}
module.exports = { start, stop }
