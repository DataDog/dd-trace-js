'use strict'

const { builtinModules } = require('module')
const path = require('path')

const { channel } = require('dc-polyfill')
const satisfies = require('semifies')

const Hook = require('./hook')
const log = require('../../../dd-trace/src/log')
const checkRequireCache = require('./check-require-cache')
const telemetry = require('../../../dd-trace/src/guardrails/telemetry')
const { isInServerlessEnvironment } = require('../../../dd-trace/src/serverless')
const { getEnvironmentVariables } = require('../../../dd-trace/src/config-helper')

const envs = getEnvironmentVariables()

const {
  DD_TRACE_DISABLED_INSTRUMENTATIONS = '',
  DD_TRACE_DEBUG = ''
} = envs

const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const names = Object.keys(hooks)
const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

const disabledInstrumentations = new Set(
  DD_TRACE_DISABLED_INSTRUMENTATIONS?.split(',')
)

const loadChannel = channel('dd-trace:instrumentation:load')
const HOOK_SYMBOL = Symbol('hookExportsSet')

// Globals
if (!disabledInstrumentations.has('fetch')) {
  require('../fetch')
}

if (!disabledInstrumentations.has('process')) {
  require('../process')
}

if (DD_TRACE_DEBUG && DD_TRACE_DEBUG.toLowerCase() !== 'false') {
  checkRequireCache.checkForRequiredModules()
  setImmediate(checkRequireCache.checkForPotentialConflicts)
}

/** @type {Map<string, object>} */
const instrumentedNodeModules = new Map()
/** @type {Map<string, boolean>} */
const instrumentedIntegrationsSuccess = new Map()
/** @type {Set<string>} */
const alreadyLoggedIncompatibleIntegrations = new Set()

// Always disable prefixed and unprefixed node modules if one is disabled.
if (disabledInstrumentations.size) {
  const builtinsSet = new Set(builtinModules)
  for (const name of disabledInstrumentations) {
    const hasPrefix = name.startsWith('node:')
    if (hasPrefix || builtinsSet.has(name)) {
      if (hasPrefix) {
        const unprefixedName = name.slice(5)
        if (!disabledInstrumentations.has(unprefixedName)) {
          disabledInstrumentations.add(unprefixedName)
        }
      } else if (!disabledInstrumentations.has(`node:${name}`)) {
        disabledInstrumentations.add(`node:${name}`)
      }
    }
  }
  builtinsSet.clear()
}

const builtinModuleSet = new Set(builtinModules)

let timeout

for (const name of names) {
  if (disabledInstrumentations.has(name)) continue

  const hookOptions = {}

  let hook = hooks[name]
  if (hook !== null && typeof hook === 'object') {
    if (hook.serverless === false && isInServerlessEnvironment()) continue

    hookOptions.internals = hook.esmFirst
    hook = hook.fn
  }

  const targetNames = builtinModuleSet.has(name) ? [name, `node:${name}`] : [name]

  targetNames.forEach(requestedName => {
    Hook([requestedName], hookOptions, (moduleExports, moduleName, moduleBaseDir,
      moduleVersion, isIitm) => {
      if (timeout === undefined) {
        // Delay the logging of aborted integrations to handle async loading graphs.
        timeout = setTimeout(() => {
          logAbortedIntegrations()
        }, 100).unref()
      } else {
        timeout.refresh()
      }
      const canonicalName = requestedName.startsWith('node:') ? requestedName.slice(5) : requestedName
      const successKey = `${canonicalName}@${moduleVersion}`

      // All loaded versions are first expected to fail instrumentation.
      if (!instrumentedIntegrationsSuccess.has(successKey)) {
        instrumentedIntegrationsSuccess.set(successKey, false)
      }

      // This executes the integration file thus adding its entries to `instrumentations`
      hook()

      if (requestedName.includes('node:') && instrumentations[canonicalName]) {
        instrumentations[requestedName] = instrumentations[canonicalName]
      }

      const instrumentationsForModule = instrumentations[requestedName]

      if (!instrumentationsForModule) {
        return moduleExports
      }

      if (moduleBaseDir) {
        moduleName = moduleName.replace(pathSepExpr, '/')
      } else {
        const aliasNames = new Set([requestedName])

        if (builtinModuleSet.has(canonicalName)) {
          aliasNames.add(canonicalName)
          aliasNames.add(`node:${canonicalName}`)
        }

        const alreadyInstrumented = [...aliasNames]
          .map(alias => instrumentedNodeModules.get(alias))
          .find(value => value !== undefined)

        if (alreadyInstrumented && moduleExports === alreadyInstrumented) {
          return moduleExports
        }

        for (const alias of aliasNames) {
          instrumentedNodeModules.set(alias, moduleExports)
        }
      }

      for (const { file, versions, hook, filePattern, patchDefault } of instrumentationsForModule) {
        if (isIitm && patchDefault === !!moduleExports.default) {
          if (patchDefault) {
            moduleExports = moduleExports.default
          } else {
            return moduleExports
          }
        }

        const fullFilename = filename(requestedName, file)
        let matchesFile = moduleName === fullFilename

        const fullFilePattern = filePattern && filename(requestedName, filePattern)
        if (fullFilePattern) {
          // Some libraries include a hash in their filenames when installed,
          // so our instrumentation has to include a '.*' to match them for more than a single version.
          matchesFile ||= new RegExp(fullFilePattern).test(moduleName)
        }

        if (matchesFile && matchVersion(moduleVersion, versions)) {
          let instrumentedExports = hook[HOOK_SYMBOL]
          if (
            !instrumentedExports &&
            moduleExports &&
            (typeof moduleExports === 'object' || typeof moduleExports === 'function')
          ) {
            instrumentedExports = new WeakSet()
            hook[HOOK_SYMBOL] = instrumentedExports
          }

          if (instrumentedExports?.has(moduleExports)) {
            instrumentedIntegrationsSuccess.set(successKey, true)
            continue
          }

          // Do not log in case of an error to prevent duplicate telemetry for the same integration version.
          instrumentedIntegrationsSuccess.set(successKey, true)
          try {
            loadChannel.publish({ name: canonicalName })

            moduleExports = hook(moduleExports, moduleVersion) ?? moduleExports

            if (
              instrumentedExports &&
              moduleExports &&
              (typeof moduleExports === 'object' || typeof moduleExports === 'function')
            ) {
              instrumentedExports.add(moduleExports)
            }
          } catch (error) {
            log.info('Error during ddtrace instrumentation of application, aborting.', error)
            telemetry('error', [
              `error_type:${error.constructor.name}`,
              `integration:${canonicalName}`,
              `integration_version:${moduleVersion}`
            ], {
              result: 'error',
              result_class: 'internal_error',
              result_reason: `Error during instrumentation of ${canonicalName}@${moduleVersion}: ${error.message}`
            })
          }
        }
      }

      return moduleExports
    })
  })
}

// Used in case the process exits before the timeout is triggered.
process.on('beforeExit', () => {
  logAbortedIntegrations()
})

function logAbortedIntegrations () {
  for (const [nameVersion, success] of instrumentedIntegrationsSuccess) {
    // Only ever log a single version of an integration, even if it is loaded later.
    if (!success && !alreadyLoggedIncompatibleIntegrations.has(nameVersion)) {
      const [name, version] = nameVersion.split('@')
      telemetry('abort.integration', [
        `integration:${name}`,
        `integration_version:${version}`
      ], {
        result: 'abort',
        result_class: 'incompatible_library',
        result_reason: `Incompatible integration version: ${name}@${version}`
      })
      log.info('Found incompatible integration version: %s', nameVersion)
      alreadyLoggedIncompatibleIntegrations.add(nameVersion)
    }
  }
  // Clear the map to avoid reporting the same integration version again.
  instrumentedIntegrationsSuccess.clear()
}

/**
 * @param {string|undefined} version
 * @param {string[]|undefined} ranges
 */
function matchVersion (version, ranges) {
  return !version || !ranges || ranges.some(range => satisfies(version, range))
}

/**
 * @param {string} name
 * @param {string} [file]
 * @returns {string}
 */
function filename (name, file) {
  return file ? `${name}/${file}` : name
}

module.exports = {
  filename,
  pathSepExpr,
  loadChannel,
  matchVersion
}
