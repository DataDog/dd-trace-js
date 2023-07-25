'use strict'

const { channel } = require('../../../diagnostics_channel')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')
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
  // path: '@redis/client', AKA Ignore, more of an ESBuild convention
  // version: '1.5.8', // AKA moduleVersion
  // package: '@redis/client',
  // relPath: 'dist/index.js'
  // module: Module AKA moduleExports
  const packageName = payload.package
  let moduleExports = payload.module
  let moduleName = payload.package.replace(pathSepExpr, '/')
  const moduleBaseDir = null // unused, for version stuff
  const moduleVersion = payload.version

  // if path === package then we're loading a package directly
  if (payload.path !== payload.package) {
    moduleName += '/' + payload.relPath
  }

  console.log('UNIVERSAL', payload)
  // console.log('INS', payload.package, payload.relPath, instrumentations)

  // COPYPASTA from the Hook call in the loop

  console.log('ESBUILD Hook()', packageName)

  // This executes the integration file thus adding its entries to `instrumentations`
  try {
    hooks[packageName]()
  } catch (err) {
    console.error('UNABLE TO RUN HOOK FOR ', packageName)
    console.error(hooks)
    process.exit()
    throw err
  }

  if (!instrumentations[packageName]) {
    // this should never happen
    console.error('UNABLE TO FIND ESBUILD INSTRUMENTATION', packageName)
    payload.module = payload.module
    return
  }

  let debug_match = false
  for (const { name, file, versions, hook } of instrumentations[packageName]) {
    const modulePathIncludingPackageName = filename(name, file) // @redis/client/dist/lib/client/index.js
    console.log('ESFF', modulePathIncludingPackageName, moduleName)

    console.log('COMPARE', moduleName, modulePathIncludingPackageName)
    if (moduleName === modulePathIncludingPackageName) {
      const version = moduleVersion || getVersion(moduleBaseDir)

      console.log('COMPARE', version, versions)
      if (matchVersion(version, versions)) {
        try {
          loadChannel.publish({ name, version, file })

          moduleExports = hook(moduleExports, version)
          debug_match = true
        } catch (e) {
          log.error(e)
        }
      }
    }
  }

  if (!debug_match) {
    console.error('NO MATCH', moduleName)
  } else {
    console.log('YES MATCH', moduleName)
  }

  payload.module = moduleExports
  return
})

// Globals
require('../fetch')

// TODO: make this more efficient

for (const packageName of names) {
  if (disabledInstrumentations.has(packageName)) continue

  Hook([packageName], (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
    console.log('Hook()', packageName)
    moduleName = moduleName.replace(pathSepExpr, '/')

    // This executes the integration file thus adding its entries to `instrumentations`
    hooks[packageName]()

    if (!instrumentations[packageName]) {
      return moduleExports
    }

    for (const { name, file, versions, hook } of instrumentations[packageName]) {
      // TODO: Sadly we can't subscribe on the channels here as the code runs AFTER modules are loaded
      const modulePathIncludingPackageName = filename(name, file) // @redis/client/dist/lib/client/index.js
      console.log('FF', modulePathIncludingPackageName, moduleName)

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
