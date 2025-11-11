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
const seenCombo = new Set()
/** @type {Record<string, boolean>} */
const allInstrumentations = {}
/** @type {Set<string>} */
const instrumentedNodeModules = new Set()

for (const name of names) {
  if (name.startsWith('node:')) {
    // Add all unprefixed node modules to the instrumentations list.
    names.push(name.slice(5))
    // Always disable prefixed and unprefixed node modules if one is disabled.
    // TODO: Activate & write a regression test for this.
    // if (disabledInstrumentations.has(name) !== disabledInstrumentations.has(`node:${name}`)) {
    //   disabledInstrumentations.add(name)
    //   disabledInstrumentations.add(`node:${name}`)
    // }
  }
}

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

  // get the instrumentation file name to save all hooked versions
  const instrumentationFileName = parseHookInstrumentationFileName(hook)

  Hook([name], hookOptions, (moduleExports, moduleName, moduleBaseDir, moduleVersion, isIitm) => {
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

    const namesAndSuccesses = {}
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
        if (namesAndSuccesses[`${nameWithoutPrefix}@${version}`] === undefined && !file) {
          // TODO If `file` is present, we might elsewhere instrument the result of the module
          // for a version range that actually matches, so we can't assume that we're _not_
          // going to instrument that. However, the way the data model around instrumentation
          // works, we can't know either way just yet, so to avoid false positives, we'll just
          // ignore this if there is a `file` in the hook. The thing to do here is rework
          // everything so that we can be sure that there are _no_ instrumentations that it
          // could match.
          namesAndSuccesses[`${nameWithoutPrefix}@${version}`] = false
        }

        if (matchVersion(version, versions)) {
          allInstrumentations[instrumentationFileName] ||= false

          try {
            loadChannel.publish({ name })

            moduleExports = hook(moduleExports, version) ?? moduleExports
          } catch (e) {
            log.info('Error during ddtrace instrumentation of application, aborting.', e)
            telemetry('error', [
              `error_type:${e.constructor.name}`,
              `integration:${nameWithoutPrefix}`,
              `integration_version:${version}`
            ], {
              result: 'error',
              result_class: 'internal_error',
              result_reason: `Error during instrumentation of ${name}@${version}: ${e.message}`
            })
          }
          namesAndSuccesses[`${nameWithoutPrefix}@${version}`] = true
        }
      }
    }
    for (const nameVersion of Object.keys(namesAndSuccesses)) {
      const success = namesAndSuccesses[nameVersion]
      // we check allVersions to see if any version of the integration was successfully instrumented
      // TODO: The allInstrumentations check is meant to fix https://github.com/DataDog/dd-trace-js/issues/5092
      // This is a workaround to actually detect if any hook inside of the instrumentation file was successful or not.
      // This could be simplified by checking it in a different way. Another alternative is to mention which hooks were
      // successful or not. That would also be better for debugging. If no filename is detected, the allInstrumentations
      // check will always be false - which is a mistake.
      // The current seenCombo also seems to be redundant to namesAndSuccesses. Refactor this if possible.
      if (!success && !seenCombo.has(nameVersion) && !allInstrumentations[instrumentationFileName]) {
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
        seenCombo.add(nameVersion)
      }
    }

    return moduleExports
  })
}

/**
 * @param {string|undefined} version
 * @param {string[]|undefined} ranges
 */
function matchVersion (version, ranges) {
  return !version || !ranges || ranges.some(range => satisfies(version, range))
}

/**
 * @param {string} moduleBaseDir
 * @returns {string|undefined}
 */
function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    return requirePackageJson(moduleBaseDir, /** @type {import('module').Module} */ (module)).version
  }
}

/**
 * @param {string} name
 * @param {string} [file]
 * @returns {string}
 */
function filename (name, file) {
  return file ? `${name}/${file}` : name
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
/**
 * @param {Function} hook
 * @returns {string|undefined}
 */
function parseHookInstrumentationFileName (hook) {
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
}

module.exports = {
  filename,
  pathSepExpr,
  loadChannel,
  matchVersion
}
