'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('diagnostics_channel')
const { fileURLToPath } = require('url')

const savedDependencies = []
const detectedDependencyNames = new Set()
const FILE_PATH_START = `file://`
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let immediate, config, application, host

function waitAndSend (config, application, host) {
  if (!immediate) {
    immediate = setImmediate(() => {
      immediate = null
      if (savedDependencies.length > 0) {
        const dependencies = savedDependencies.splice(0, 1000)
        sendData(config, application, host, 'app-dependencies-loaded', { dependencies })
        if (savedDependencies.length > 0) {
          waitAndSend(config, application, host)
        }
      }
    })
    immediate.unref()
  }
}

function onModuleLoad (data) {
  if (data) {
    let filename = data.filename
    if (filename && filename.substring(0, 7) === FILE_PATH_START) {
      try {
        filename = fileURLToPath(filename)
      } catch (e) {
        // cannot transform url to path
      }
    }
    const parseResult = filename && parse(filename)
    const request = data.request || (parseResult && parseResult.name)
    if (filename && request && isDependency(filename, request) && !detectedDependencyNames.has(request)) {
      detectedDependencyNames.add(request)
      if (parseResult) {
        const { name, basedir } = parseResult
        if (basedir) {
          try {
            const { version } = requirePackageJson(cleanPath(basedir), module)
            savedDependencies.push({ name, version })
            waitAndSend(config, application, host)
          } catch (e) {
            // can not read the package.json, do nothing
          }
        }
      }
    }
  }
}
function start (_config, _application, _host) {
  config = _config
  application = _application
  host = _host
  moduleLoadStartChannel.subscribe(onModuleLoad)
}

function cleanPath (path) {
  if (path.indexOf(FILE_PATH_START) === 0) {
    return path.substring(FILE_PATH_START.length)
  }
  return path
}

function isDependency (filename, request) {
  return request.indexOf(`.${path.sep}`) !== 0 && request.indexOf(path.sep) !== 0
}

function stop () {
  config = null
  application = null
  host = null
  detectedDependencyNames.clear()
  savedDependencies.splice(0, savedDependencies.length)
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.unsubscribe(onModuleLoad)
  }
}
module.exports = { start, stop }
