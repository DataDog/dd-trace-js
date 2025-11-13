'use strict'

const { channel } = require('dc-polyfill')
const path = require('path')
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

/** @type {Set<string>} */
const instrumentedNodeModules = new Set()
/** @type {Map<string, boolean>} */
const instrumentedIntegrationsSuccess = new Map()
/** @type {Set<string>} */
const alreadyLoggedIncompatibleIntegrations = new Set()

for (const name of names) {
  if (name.startsWith('node:')) {
    // Add all unprefixed node modules to the instrumentations list.
    const unprefixedName = name.slice(5)
    names.push(unprefixedName)
    // Always disable prefixed and unprefixed node modules if one is disabled.
    if (disabledInstrumentations.has(name) !== disabledInstrumentations.has(unprefixedName)) {
      disabledInstrumentations.add(name)
      disabledInstrumentations.add(unprefixedName)
    }
  }
}

let timeout

for (const name of names) {
  if (disabledInstrumentations.has(name)) continue

  const isNodeModule = name.startsWith('node:') || !hooks[name]

  const hookOptions = {}

  let hook = hooks[name] ?? hooks[`node:${name}`]

  if (hook !== null && typeof hook === 'object') {
    if (hook.serverless === false && isInServerlessEnvironment()) continue

    hookOptions.internals = hook.esmFirst
    hook = hook.fn
  }

  const nameWithoutPrefix = name.startsWith('node:') ? name.slice(5) : name

  Hook([name], hookOptions, (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
    if (timeout === undefined) {
      // Delay the logging of aborted integrations to handle async loading graphs.
      timeout = setTimeout(() => {
        logAbortedIntegrations()
      }, 100).unref()
    } else {
      timeout.refresh()
    }
    // All loaded versions are first expected to fail instrumentation.
    if (!instrumentedIntegrationsSuccess.has(`${nameWithoutPrefix}@${moduleVersion}`)) {
      instrumentedIntegrationsSuccess.set(`${nameWithoutPrefix}@${moduleVersion}`, false)
    }
    moduleName = moduleName.replace(pathSepExpr, '/')

    // This executes the integration file thus adding its entries to `instrumentations`
    hook()

    if (!instrumentations[nameWithoutPrefix] || instrumentedNodeModules.has(nameWithoutPrefix)) {
      return moduleExports
    }

    // Used for node: prefixed modules to prevent double instrumentation.
    if (isNodeModule) {
      instrumentedNodeModules.add(nameWithoutPrefix)
    }

    for (const { file, versions, hook, filePattern, patchDefault } of instrumentations[nameWithoutPrefix]) {
      if (isIitm && patchDefault === !!moduleExports.default) {
        if (patchDefault) {
          moduleExports = moduleExports.default
        } else {
          return moduleExports
        }
      }

      const fullFilename = filename(name, file)

      let matchesFile = moduleName === fullFilename

      const fullFilePattern = filePattern && filename(name, filePattern)
      if (fullFilePattern) {
        // Some libraries include a hash in their filenames when installed,
        // so our instrumentation has to include a '.*' to match them for more than a single version.
        matchesFile ||= new RegExp(fullFilePattern).test(moduleName)
      }

      if (matchesFile && matchVersion(moduleVersion, versions)) {
        // Do not log in case of an error to prevent duplicate telemetry for the same integration version.
        instrumentedIntegrationsSuccess.set(`${nameWithoutPrefix}@${moduleVersion}`, true)
        try {
          loadChannel.publish({ name })

          moduleExports = hook(moduleExports, moduleVersion) ?? moduleExports
        } catch (error) {
          log.info('Error during ddtrace instrumentation of application, aborting.', error)
          telemetry('error', [
            `error_type:${error.constructor.name}`,
            `integration:${nameWithoutPrefix}`,
            `integration_version:${moduleVersion}`
          ], {
            result: 'error',
            result_class: 'internal_error',
            result_reason: `Error during instrumentation of ${name}@${moduleVersion}: ${error.message}`
          })
        }
      }
    }

    return moduleExports
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
