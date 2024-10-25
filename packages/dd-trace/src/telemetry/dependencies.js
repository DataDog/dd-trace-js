'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('dc-polyfill')
const { fileURLToPath } = require('url')
const { isTrue } = require('../../src/util')

const savedDependenciesToSend = new Set()
const detectedDependencyKeys = new Set()
const detectedDependencyVersions = new Set()

const FILE_URI_START = 'file://'
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let immediate, config, application, host, initialLoad
let isFirstModule = true
let getRetryData
let updateRetryData

function createBatchPayload (payload) {
  const batchPayload = payload.map(item => {
    return {
      request_type: item.reqType,
      payload: item.payload
    }
  })

  return batchPayload
}
function waitAndSend (config, application, host) {
  if (!immediate) {
    immediate = setImmediate(() => {
      immediate = null
      if (savedDependenciesToSend.size > 0) {
        const dependencies = Array.from(savedDependenciesToSend.values())
          // if a depencdency is from the initial load, *always* send the event
          // Otherwise, only send if dependencyCollection is enabled
          .filter(dep => {
            const initialLoadModule = isTrue(dep.split(' ')[2])
            const sendModule = initialLoadModule || (config.telemetry?.dependencyCollection)

            if (!sendModule) savedDependenciesToSend.delete(dep) // we'll never send it
            return sendModule
          })
          .splice(0, 2000) // v2 documentation specifies up to 2000 dependencies can be sent at once
          .map(pair => {
            savedDependenciesToSend.delete(pair)
            const [name, version] = pair.split(' ')
            return { name, version }
          })
        let currPayload
        const retryData = getRetryData()
        if (retryData) {
          currPayload = { reqType: 'app-dependencies-loaded', payload: { dependencies } }
        } else {
          if (!dependencies.length) return // no retry data and no dependencies, nothing to send
          currPayload = { dependencies }
        }

        const payload = retryData ? createBatchPayload([currPayload, retryData]) : currPayload
        const reqType = retryData ? 'message-batch' : 'app-dependencies-loaded'

        sendData(config, application, host, reqType, payload, updateRetryData)

        if (savedDependenciesToSend.size > 0) {
          waitAndSend(config, application, host)
        }
      }
    })
    immediate.unref()
  }
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
    if (filename && filename.startsWith(FILE_URI_START)) {
      try {
        filename = fileURLToPath(filename)
      } catch (e) {
        // cannot transform url to path
      }
    }
    const parseResult = filename && parse(filename)
    const request = data.request || (parseResult && parseResult.name)
    const dependencyKey = parseResult && parseResult.basedir ? parseResult.basedir : request

    if (filename && request && isDependency(filename, request) && !detectedDependencyKeys.has(dependencyKey)) {
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
          } catch (e) {
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

  // try and capture intially loaded modules in the first tick
  // since, ideally, the tracer (and this module) should be loaded first,
  // this should capture any first-tick dependencies
  queueMicrotask(() => { initialLoad = false })
}

function isDependency (filename, request) {
  const isDependencyWithSlash = isDependencyWithSeparator(filename, request, '/')
  if (isDependencyWithSlash && process.platform === 'win32') {
    return isDependencyWithSeparator(filename, request, path.sep)
  }
  return isDependencyWithSlash
}
function isDependencyWithSeparator (filename, request, sep) {
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
