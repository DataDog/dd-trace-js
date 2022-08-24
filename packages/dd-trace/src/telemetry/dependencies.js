'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const { requirePackageVersion } = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('diagnostics_channel')

const savedDependencies = []
const detectedDependencyNames = new Set()
const FILE_PATH_START = `file:${path.sep}${path.sep}`
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let timeout, config, application, host

function waitAndSend (config, application, host) {
  if (!timeout) {
    timeout = setTimeout(() => {
      timeout = null
      if (savedDependencies.length > 0) {
        const dependencies = savedDependencies.splice(0, 1000)
        sendData(config, application, host, 'app-dependencies-loaded', { dependencies })
        if (savedDependencies.length > 0) {
          waitAndSend(config, application, host)
        }
      }
    }, 1000)
    timeout.unref()
  }
}

function onModuleLoad (data) {
  if (data) {
    const { filename, request } = data
    if (filename && request && isDependency(filename, request) && !detectedDependencyNames.has(request)) {
      detectedDependencyNames.add(data.request)
      const parseResult = parse(filename)
      if (parseResult) {
        const { name, basedir } = parseResult
        if (basedir) {
          try {
            const version = requirePackageVersion(cleanPath(basedir), module)
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
