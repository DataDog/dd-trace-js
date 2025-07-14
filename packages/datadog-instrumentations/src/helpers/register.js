'use strict'

const { channel } = require('dc-polyfill')
const path = require('path')
const satisfies = require('semifies')
const Hook = require('./hook')
const requirePackageJson = require('../../../dd-trace/src/require-package-json')
const log = require('../../../dd-trace/src/log')
const checkRequireCache = require('./check-require-cache')
const telemetry = require('../../../dd-trace/src/guardrails/telemetry')
const { isInServerlessEnvironment } = require('../../../dd-trace/src/serverless')
const { isFalse, isTrue, normalizePluginEnvName } = require('../../../dd-trace/src/util')
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
  DD_TRACE_DISABLED_INSTRUMENTATIONS?.split(',').map(name => normalizePluginEnvName(name, true)) ?? []
)
const reenabledInstrumentations = new Set()

// Check for DD_TRACE_<INTEGRATION>_ENABLED environment variables
for (const [key, value] of Object.entries(envs)) {
  const match = key.match(/^DD_TRACE_(.+)_ENABLED$/)
  if (match && value) {
    const integration = normalizePluginEnvName(match[1], true)
    if (isFalse(value)) {
      disabledInstrumentations.add(integration)
    } else if (isTrue(value)) {
      reenabledInstrumentations.add(integration)
    }
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

const HOOK_SYMBOL = Symbol('hookExportsSet')

if (DD_TRACE_DEBUG && DD_TRACE_DEBUG.toLowerCase() !== 'false') {
  checkRequireCache.checkForRequiredModules()
  setImmediate(checkRequireCache.checkForPotentialConflicts)
}

const seenCombo = new Set()
const allInstrumentations = {}

// TODO: make this more efficient
for (const packageName of names) {
  const normalizedPackageName = normalizePluginEnvName(packageName, true)
  if (disabledInstrumentations.has(normalizedPackageName)) continue

  const hookOptions = {}

  let hook = hooks[packageName]

  if (hook !== null && typeof hook === 'object') {
    if (hook.serverless === false && isInServerlessEnvironment()) continue

    // some integrations are disabled by default, but can be enabled by setting
    // the DD_TRACE_<INTEGRATION>_ENABLED environment variable to true
    if (hook.disabled && !reenabledInstrumentations.has(normalizedPackageName)) continue

    hookOptions.internals = hook.esmFirst
    hook = hook.fn
  }

  // get the instrumentation file name to save all hooked versions
  const instrumentationFileName = parseHookInstrumentationFileName(packageName)

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

      // Create a WeakSet associated with the hook function so that patches on the same moduleExport only happens once
      // for example by instrumenting both dns and node:dns double the spans would be created
      // since they both patch the same moduleExport, this WeakSet is used to mitigate that
      // TODO(BridgeAR): Instead of using a WeakSet here, why not just use aliases for the hook in register?
      // That way it would also not be duplicated. The actual name being used has to be identified else wise.
      // Maybe it is also not important to know what name was actually used?
      hook[HOOK_SYMBOL] ??= new WeakSet()
      let matchesFile = moduleName === fullFilename

      if (fullFilePattern) {
        // Some libraries include a hash in their filenames when installed,
        // so our instrumentation has to include a '.*' to match them for more than a single version.
        matchesFile = matchesFile || new RegExp(fullFilePattern).test(moduleName)
      }

      if (matchesFile) {
        let version = moduleVersion
        try {
          version = version || getVersion(moduleBaseDir)
          allInstrumentations[instrumentationFileName] = allInstrumentations[instrumentationFileName] || false
        } catch (e) {
          log.error('Error getting version for "%s": %s', name, e.message, e)
          continue
        }
        if (namesAndSuccesses[`${name}@${version}`] === undefined && !file) {
          // TODO If `file` is present, we might elsewhere instrument the result of the module
          // for a version range that actually matches, so we can't assume that we're _not_
          // going to instrument that. However, the way the data model around instrumentation
          // works, we can't know either way just yet, so to avoid false positives, we'll just
          // ignore this if there is a `file` in the hook. The thing to do here is rework
          // everything so that we can be sure that there are _no_ instrumentations that it
          // could match.
          namesAndSuccesses[`${name}@${version}`] = false
        }

        if (matchVersion(version, versions)) {
          allInstrumentations[instrumentationFileName] = true

          // Check if the hook already has a set moduleExport
          if (hook[HOOK_SYMBOL].has(moduleExports)) {
            namesAndSuccesses[`${name}@${version}`] = true
            return moduleExports
          }

          try {
            loadChannel.publish({ name, version, file })
            // Send the name and version of the module back to the callback because now addHook
            // takes in an array of names so by passing the name the callback will know which module name is being used
            // TODO(BridgeAR): This is only true in case the name is identical
            // in all loads. If they deviate, the deviating name would not be
            // picked up due to the unification. Check what modules actually use the name.
            // TODO(BridgeAR): Only replace moduleExports if the hook returns a new value.
            // This allows to reduce the instrumentation code (no return needed).
            moduleExports = hook(moduleExports, version, name) ?? moduleExports
            // Set the moduleExports in the hooks WeakSet
            hook[HOOK_SYMBOL].add(moduleExports)
          } catch (e) {
            log.info('Error during ddtrace instrumentation of application, aborting.', e)
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
      // we check allVersions to see if any version of the integration was successfully instrumented
      if (!success && !seenCombo.has(nameVersion) && !allInstrumentations[instrumentationFileName]) {
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
  return !version || !ranges || ranges.some(range => satisfies(version, range))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, module).version
  }
}

function filename (name, file) {
  return [name, file].filter(Boolean).join('/')
}

// This function captures the instrumentation file name for a given package by parsing the hook require
// function given the module name. It is used to ensure that instrumentations such as redis
// that have several different modules being hooked, ie: 'redis' main package, and @redis/client submodule
// return a consistent instrumentation name. This is used later to ensure that at least some portion of
// the integration was successfully instrumented. Prevents incorrect `Found incompatible integration version: ` messages
// Example:
//                  redis -> "() => require('../redis')" -> redis
//          @redis/client -> "() => require('../redis')" -> redis
//
function parseHookInstrumentationFileName (packageName) {
  let hook = hooks[packageName]
  if (hook.fn) {
    hook = hook.fn
  }
  const hookString = hook.toString()

  const regex = /require\('([^']*)'\)/
  const match = hookString.match(regex)

  // try to capture the hook require file location.
  if (match && match[1]) {
    let moduleName = match[1]
    // Remove leading '../' if present
    if (moduleName.startsWith('../')) {
      moduleName = moduleName.slice(3)
    }
    return moduleName
  }

  return null
}

module.exports = {
  filename,
  pathSepExpr,
  loadChannel,
  matchVersion
}
