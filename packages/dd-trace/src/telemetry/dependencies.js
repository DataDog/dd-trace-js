'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('../../../diagnostics_channel')
const { fileURLToPath } = require('url')

const savedDependencies = new Set()
const detectedDependencyNames = new Set()
const FILE_URI_START = `file://`
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let immediate, config, application, host

function waitAndSend (config, application, host) {
  if (!immediate) {
    immediate = setImmediate(() => {
      immediate = null
      if (savedDependencies.size > 0) {
        const dependencies = Array.from(savedDependencies.values()).splice(0, 1000).map(pair => {
          savedDependencies.delete(pair)
          const [name, version] = pair.split(' ')
          return { name, version }
        })
        sendData(config, application, host, 'app-dependencies-loaded', { dependencies })
        if (savedDependencies.size > 0) {
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
    if (filename && filename.startsWith(FILE_URI_START)) {
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
            const { version } = requirePackageJson(basedir, module)
            savedDependencies.add(`${name} ${version}`)
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
  detectedDependencyNames.clear()
  savedDependencies.clear()
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.unsubscribe(onModuleLoad)
  }
}
module.exports = { start, stop }
