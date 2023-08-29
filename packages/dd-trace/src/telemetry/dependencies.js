'use strict'

const path = require('path')
const parse = require('module-details-from-path')
const requirePackageJson = require('../require-package-json')
const { sendData } = require('./send-data')
const dc = require('../../../diagnostics_channel')
const { fileURLToPath } = require('url')

const savedDependenciesToSend = new Set()
const detectedDependencyKeys = new Set()
const detectedDependencyVersions = new Set()

const FILE_URI_START = `file://`
const moduleLoadStartChannel = dc.channel('dd-trace:moduleLoadStart')

let immediate, config, application, host
let isFirstModule = true

function waitAndSend (config, application, host) {
  if (!immediate) {
    immediate = setImmediate(() => {
      immediate = null
      if (savedDependenciesToSend.size > 0) {
        const dependencies = Array.from(savedDependenciesToSend.values()).splice(0, 1000).map(pair => {
          savedDependenciesToSend.delete(pair)
          const [name, version] = pair.split(' ')
          return { name, version }
        })
        sendData(config, application, host, 'app-dependencies-loaded', { dependencies })
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
              savedDependenciesToSend.add(dependencyAndVersion)
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
  detectedDependencyKeys.clear()
  savedDependenciesToSend.clear()
  detectedDependencyVersions.clear()
  if (moduleLoadStartChannel.hasSubscribers) {
    moduleLoadStartChannel.unsubscribe(onModuleLoad)
  }
}
module.exports = { start, stop }
