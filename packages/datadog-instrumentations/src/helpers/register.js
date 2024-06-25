'use strict'

const { channel } = require('dc-polyfill')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')
const checkRequireCache = require('../check_require_cache')

const {
  DD_TRACE_DISABLED_INSTRUMENTATIONS = '',
  DD_TRACE_DEBUG = ''
} = process.env

const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const names = Object.keys(hooks)
const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')
const disabledInstrumentations = new Set(
  DD_TRACE_DISABLED_INSTRUMENTATIONS ? DD_TRACE_DISABLED_INSTRUMENTATIONS.split(',') : []
)

const loadChannel = channel('dd-trace:instrumentation:load')

// Globals
if (!disabledInstrumentations.has('fetch')) {
  require('../fetch')
}

const HOOK_SYMBOL = Symbol('hookExportsMap')

if (DD_TRACE_DEBUG && DD_TRACE_DEBUG.toLowerCase() !== 'false') {
  checkRequireCache.checkForRequiredModules()
  setImmediate(checkRequireCache.checkForPotentialConflicts)
}

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

      // Create a WeakMap associated with the hook function so that patches on the same moduleExport only happens once
      // for example by instrumenting both dns and node:dns double the spans would be created
      // since they both patch the same moduleExport, this WeakMap is used to mitigate that
      if (!hook[HOOK_SYMBOL]) {
        hook[HOOK_SYMBOL] = new WeakMap()
      }

      if (moduleName === fullFilename) {
        const version = moduleVersion || getVersion(moduleBaseDir)

        if (matchVersion(version, versions)) {
          // Check if the hook already has a set moduleExport
          if (hook[HOOK_SYMBOL].has(moduleExports)) {
            return moduleExports
          }

          try {
            loadChannel.publish({ name, version, file })
            // Send the name and version of the module back to the callback because now addHook
            // takes in an array of names so by passing the name the callback will know which module name is being used
            moduleExports = hook(moduleExports, version, name)
            // Set the moduleExports in the hooks weakmap
            hook[HOOK_SYMBOL].set(moduleExports, name)
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
  pathSepExpr,
  loadChannel,
  matchVersion
}
