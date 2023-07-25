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
  const packageName = payload.package
  let moduleExports = payload.module
  let moduleName = payload.package.replace(pathSepExpr, '/')
  const moduleBaseDir = null // unused, for version stuff
  const moduleVersion = payload.version
  const loadingPackageExternally = payload.path === payload.package

  if (!loadingPackageExternally) {
    moduleName += '/' + payload.relPath
  }

  hooks[packageName]()

  if (!instrumentations[packageName]) {
    log.error(`esbuild-wrapped ${packageName} missing in list of instrumentations`)
    return
  }

  for (const { name, file, versions, hook } of instrumentations[packageName]) {
    const modulePathIncludingPackageName = filename(name, file) // @redis/client/dist/lib/client/index.js

    if (moduleName === modulePathIncludingPackageName) {
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

  payload.module = moduleExports
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
      const modulePathIncludingPackageName = filename(name, file) // @redis/client/dist/lib/client/index.js

      if (moduleName === modulePathIncludingPackageName) {
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
