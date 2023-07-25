'use strict'

const { channel } = require('../../../diagnostics_channel')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')
// eslint-disable-next-line n/no-restricted-require
const dc = require('diagnostics_channel')

const { DD_TRACE_DISABLED_INSTRUMENTATIONS = '' } = process.env

const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const names = Object.keys(hooks)
const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')
const disabledInstrumentations = new Set(
  DD_TRACE_DISABLED_INSTRUMENTATIONS ? DD_TRACE_DISABLED_INSTRUMENTATIONS.split(',') : []
)

const loadChannel = channel('dd-trace:instrumentation:load')

if (!dc.subscribe) {
  dc.subscribe = (channel, cb) => {
    dc.channel(channel).subscribe(cb)
  }
}
if (!dc.unsubscribe) {
  dc.unsubscribe = (channel, cb) => {
    if (dc.channel(channel).hasSubscribers) {
      dc.channel(channel).unsubscribe(cb)
    }
  }
}

dc.subscribe('dd-trace-esbuild', (payload) => {
  let moduleName = payload.package.replace(pathSepExpr, '/')

  if (payload.path !== payload.package) {
    moduleName += '/' + payload.relPath
  }

  try {
    hooks[payload.package]()
  } catch (err) {
    log.error(`esbuild-wrapped ${payload.package} missing in list of hooks`)
    throw err
  }

  if (!instrumentations[payload.package]) {
    log.error(`esbuild-wrapped ${payload.package} missing in list of instrumentations`)
    return
  }

  for (const { name, file, versions, hook } of instrumentations[payload.package]) {
    if (moduleName !== filename(name, file)) continue
    if (!matchVersion(payload.version, versions)) continue

    try {
      loadChannel.publish({ name, version: payload.version, file })
      payload.module = hook(payload.module, payload.version)
    } catch (e) {
      log.error(e)
    }
  }
})

// Globals
require('../fetch')

// TODO: make this more efficient

for (const packageName of names) {
  if (disabledInstrumentations.has(packageName)) continue

  Hook([packageName], (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
    moduleName = moduleName.replace(pathSepExpr, '/')

    // This executes the integration file thus adding its entries to `instrumentations`
    hooks[packageName]()

    if (!instrumentations[packageName]) {
      return moduleExports
    }

    for (const { name, file, versions, hook } of instrumentations[packageName]) {
      const fullFilename = filename(name, file)

      if (moduleName === fullFilename) {
        const version = moduleVersion || getVersion(moduleBaseDir)

        if (matchVersion(version, versions)) {
          try {
            loadChannel.publish({ name, version, file })

            moduleExports = hook(moduleExports, version)
          } catch (e) {
            log.error(e)
          }
        }
      }
    }

    return moduleExports
  })
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(val => val).join('/')
}

module.exports = {
  filename,
  pathSepExpr
}
