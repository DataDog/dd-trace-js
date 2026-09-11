'use strict'

const path = require('path')
const { channel } = require('dc-polyfill')
const log = require('../../../dd-trace/src/log')
const telemetry = require('../../../dd-trace/src/guardrails/telemetry')
const { IS_SERVERLESS } = require('../../../dd-trace/src/serverless')
const { getValueFromEnvSources } = require('../../../dd-trace/src/config/helper')
const checkRequireCache = require('./check-require-cache')
const Hook = require('./hook')
const {
  filename,
  getDisabledInstrumentations,
  matchesInstrumentation,
} = require('./instrumentation-utils')
const rewriter = require('./rewriter')

const DD_TRACE_DEBUG = getValueFromEnvSources('DD_TRACE_DEBUG')

const hooks = require('./hooks')
const instrumentations = require('./instrumentations')
const names = Object.keys(hooks)
const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

const disabledInstrumentations = getDisabledInstrumentations()

const loadChannel = channel('dd-trace:instrumentation:load')

// Globals
if (!disabledInstrumentations.has('fetch')) {
  require('../fetch')
}

if (!disabledInstrumentations.has('process')) {
  require('../process')
}

const debugEnabled = DD_TRACE_DEBUG
checkRequireCache.checkForRequiredModules()
if (debugEnabled) {
  setImmediate(checkRequireCache.checkForPotentialConflicts)
}

for (const inst of disabledInstrumentations) {
  rewriter.disable(inst)
}

/** @type {Map<string, object>} */
const instrumentedNodeModules = new Map()
/** @type {Map<string, boolean>} */
const instrumentedIntegrationsSuccess = new Map()
/** @type {Set<string>} */
const alreadyLoggedIncompatibleIntegrations = new Set()
/** @type {Map<string, Function>} */
const instrumentationHooks = new Map()

/**
 * @param {unknown} error
 * @param {string} name
 * @param {string|undefined} moduleVersion
 */
function reportInstrumentationError (error, name, moduleVersion) {
  const errorType = error instanceof Error ? error.constructor.name : typeof error
  const errorMessage = error instanceof Error ? error.message : errorType
  log.info('Error during ddtrace instrumentation of application, aborting: %s', errorMessage, error)
  telemetry('error', [
    `error_type:${errorType}`,
    `integration:${name}`,
    `integration_version:${moduleVersion}`,
  ], {
    result: 'error',
    result_class: 'internal_error',
    result_reason: `Error during instrumentation of ${name}@${moduleVersion}: ${errorMessage}`,
  })
}

/**
 * @param {unknown} moduleExports
 * @param {string} name
 * @param {string} moduleName
 * @param {string} moduleBaseDir
 * @param {string|undefined} moduleVersion
 * @returns {unknown}
 */
function instrumentModule (moduleExports, name, moduleName, moduleBaseDir, moduleVersion) {
  const hook = instrumentationHooks.get(name)
  if (!hook) return moduleExports
  return hook(moduleExports, moduleName, moduleBaseDir, moduleVersion)
}

for (const name of names) {
  if (disabledInstrumentations.has(name)) continue

  const hookOptions = {}

  let hook = hooks[name]

  if (hook !== null && typeof hook === 'object') {
    if (hook.serverless === false && IS_SERVERLESS) continue

    hookOptions.internals = hook.esmFirst
    hook = hook.fn
  }

  /**
   * @param {unknown} moduleExports
   * @param {string} moduleName
   * @param {string|undefined} moduleBaseDir
   * @param {string|undefined} moduleVersion
   * @param {boolean|undefined} isIitm
   * @param {string|undefined} integration
   */
  const onrequire = (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm, integration) => {
    if (integration !== undefined && disabledInstrumentations.has(integration)) return moduleExports

    // All loaded versions are first expected to fail instrumentation.
    if (!instrumentedIntegrationsSuccess.has(`${name}@${moduleVersion}`)) {
      instrumentedIntegrationsSuccess.set(`${name}@${moduleVersion}`, false)
    }

    // This executes the integration file thus adding its entries to `instrumentations`
    try {
      hook()
    } catch (error) {
      instrumentedIntegrationsSuccess.set(`${name}@${moduleVersion}`, true)
      reportInstrumentationError(error, name, moduleVersion)
      return moduleExports
    }

    if (!instrumentations[name] || moduleExports === instrumentedNodeModules.get(name)) {
      return moduleExports
    }

    // Used for node: prefixed modules to prevent double instrumentation.
    if (moduleBaseDir) {
      moduleName = moduleName.replace(pathSepExpr, '/')
    } else {
      instrumentedNodeModules.set(name, moduleExports)
    }

    for (const instrumentation of instrumentations[name]) {
      if (matchesInstrumentation(name, moduleVersion, moduleName, instrumentation)) {
        const { hook, patchDefault } = instrumentation
        // IITM invokes this callback for every module in the package. Only unwrap the namespace after its file and
        // version match, otherwise a default export from an unrelated internal module can replace that module.
        if (isIitm && patchDefault === !!moduleExports.default) {
          if (patchDefault) {
            moduleExports = moduleExports.default
          } else {
            return moduleExports
          }
        }

        // Do not log in case of an error to prevent duplicate telemetry for the same integration version.
        instrumentedIntegrationsSuccess.set(`${name}@${moduleVersion}`, true)
        try {
          loadChannel.publish({ name })

          moduleExports = hook(moduleExports, moduleVersion, isIitm, { moduleBaseDir, moduleName }) ?? moduleExports
        } catch (error) {
          reportInstrumentationError(error, name, moduleVersion)
        }
      }
    }

    return moduleExports
  }

  instrumentationHooks.set(name, onrequire)
  Hook([name], hookOptions, onrequire)
}

globalThis[Symbol.for('dd-trace')]?.beforeExitHandlers.add(logAbortedIntegrations)
// TODO: check if we want to stop using channels for single subscriber tasks
channel('dd-trace:exporter:first-flush').subscribe(logAbortedIntegrations)

function logAbortedIntegrations () {
  for (const [nameVersion, success] of instrumentedIntegrationsSuccess) {
    // Only ever log a single version of an integration, even if it is loaded later.
    if (!success && !alreadyLoggedIncompatibleIntegrations.has(nameVersion)) {
      const lastAtPosition = nameVersion.lastIndexOf('@')
      const name = nameVersion.slice(0, lastAtPosition)
      const version = nameVersion.slice(lastAtPosition + 1)
      telemetry('abort.integration', [
        `integration:${name}`,
        `integration_version:${version}`,
      ], {
        result: 'abort',
        result_class: 'incompatible_library',
        result_reason: `Incompatible integration version: ${name}@${version}`,
      })
      log.info('Found incompatible integration version: %s', nameVersion)
      alreadyLoggedIncompatibleIntegrations.add(nameVersion)
    }
  }
  // Clear the map to avoid reporting the same integration version again.
  instrumentedIntegrationsSuccess.clear()
}

module.exports = {
  filename,
  instrumentModule,
  pathSepExpr,
  loadChannel,
}
