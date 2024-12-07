'use strict'

const { channel } = require('dc-polyfill')
const path = require('path')
const semver = require('semver')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')
const checkRequireCache = require('../check_require_cache')
const telemetry = require('../../../dd-trace/src/guardrails/telemetry')

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

// Check for DD_TRACE_<INTEGRATION>_ENABLED environment variables
for (const [key, value] of Object.entries(process.env)) {
  const match = key.match(/^DD_TRACE_(.+)_ENABLED$/)
  if (match && (value.toLowerCase() === 'false' || value === '0')) {
    const integration = match[1].toLowerCase()
    disabledInstrumentations.add(integration)
  }
}

const loadChannel = channel('dd-trace:instrumentation:load')

// Globals
if (!disabledInstrumentations.has('fetch')) {
  require('../fetch')
}

if (!disabledInstrumentations.has('process')) {
  require('../process')
}

const HOOK_SYMBOL = Symbol('hookExportsMap')

if (DD_TRACE_DEBUG && DD_TRACE_DEBUG.toLowerCase() !== 'false') {
  checkRequireCache.checkForRequiredModules()
  setImmediate(checkRequireCache.checkForPotentialConflicts)
}

const seenCombo = new Set()

// TODO: make this more efficient
for (const packageName of names) {
  if (disabledInstrumentations.has(packageName)) continue

  const hookOptions = {}

  let hook = hooks[packageName]

  if (typeof hook === 'object') {
    hookOptions.internals = hook.esmFirst
    hook = hook.fn
  }

  Hook([packageName], hookOptions, (moduleExports, moduleName, moduleBaseDir, moduleVersion) => {
    moduleName = moduleName.replace(pathSepExpr, '/')

    // This executes the integration file thus adding its entries to `instrumentations`
    hook()

    if (!instrumentations[packageName]) {
      return moduleExports
    }

    const namesAndSuccesses = {}
    for (const { name, file, versions, hook, filePattern } of instrumentations[packageName]) {
      let fullFilePattern = filePattern
      const fullFilename = filename(name, file)
      if (fullFilePattern) {
        fullFilePattern = filename(name, fullFilePattern)
      }

      // Create a WeakMap associated with the hook function so that patches on the same moduleExport only happens once
      // for example by instrumenting both dns and node:dns double the spans would be created
      // since they both patch the same moduleExport, this WeakMap is used to mitigate that
      if (!hook[HOOK_SYMBOL]) {
        hook[HOOK_SYMBOL] = new WeakMap()
      }
      let matchesFile = false

      matchesFile = moduleName === fullFilename

      if (fullFilePattern) {
        // Some libraries include a hash in their filenames when installed,
        // so our instrumentation has to include a '.*' to match them for more than a single version.
        matchesFile = matchesFile || new RegExp(fullFilePattern).test(moduleName)
      }

      if (matchesFile) {
        let version = moduleVersion
        try {
          version = version || getVersion(moduleBaseDir)
        } catch (e) {
          log.error('Error getting version for "%s": %s', name, e.message, e)
          continue
        }
        if (typeof namesAndSuccesses[`${name}@${version}`] === 'undefined') {
          namesAndSuccesses[`${name}@${version}`] = false
        }

        if (matchVersion(version, versions)) {
          // Check if the hook already has a set moduleExport
          if (hook[HOOK_SYMBOL].has(moduleExports)) {
            namesAndSuccesses[`${name}@${version}`] = true
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
            log.info('Error during ddtrace instrumentation of application, aborting.')
            log.info(e)
            telemetry('error', [
              `error_type:${e.constructor.name}`,
              `integration:${name}`,
              `integration_version:${version}`
            ])
          }
          namesAndSuccesses[`${name}@${version}`] = true
        }
      }
    }
    for (const nameVersion of Object.keys(namesAndSuccesses)) {
      const [name, version] = nameVersion.split('@')
      const success = namesAndSuccesses[nameVersion]
      if (!success && !seenCombo.has(nameVersion)) {
        telemetry('abort.integration', [
          `integration:${name}`,
          `integration_version:${version}`
        ])
        log.info('Found incompatible integration version: %s', nameVersion)
        seenCombo.add(nameVersion)
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
