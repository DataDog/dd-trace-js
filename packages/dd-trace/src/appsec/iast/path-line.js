'use strict'

const path = require('path')
const process = require('process')
const { calculateDDBasePath } = require('../../util')
const pathLine = {
  getFirstNonDDPathAndLine,
  getFirstNonDDPathAndLineFromCallsites, // Exported only for test purposes
  calculateDDBasePath, // Exported only for test purposes
  ddBasePath: calculateDDBasePath(__dirname) // Only for test purposes
}

const EXCLUDED_PATHS = [
  path.join(path.sep, 'node_modules', 'diagnostics_channel')
]
const EXCLUDED_PATH_PREFIXES = [
  'node:diagnostics_channel',
  'diagnostics_channel',
  'node:child_process',
  'child_process',
  'node:async_hooks',
  'async_hooks'
]

function getCallSiteInfo () {
  const previousPrepareStackTrace = Error.prepareStackTrace
  const previousStackTraceLimit = Error.stackTraceLimit
  let callsiteList
  Error.stackTraceLimit = 100
  Error.prepareStackTrace = function (_, callsites) {
    callsiteList = callsites
  }
  const e = new Error()
  e.stack
  Error.prepareStackTrace = previousPrepareStackTrace
  Error.stackTraceLimit = previousStackTraceLimit
  return callsiteList
}

function getFirstNonDDPathAndLineFromCallsites (callsites, externallyExcludedPaths) {
  if (callsites) {
    for (let i = 0; i < callsites.length; i++) {
      const callsite = callsites[i]
      const filepath = callsite.getFileName()
      if (!isExcluded(callsite, externallyExcludedPaths) && filepath.indexOf(pathLine.ddBasePath) === -1) {
        return {
          path: path.relative(process.cwd(), filepath),
          line: callsite.getLineNumber(),
          isInternal: !path.isAbsolute(filepath)
        }
      }
    }
  }
  return null
}

function isExcluded (callsite, externallyExcludedPaths) {
  if (callsite.isNative()) return true
  const filename = callsite.getFileName()
  if (!filename) {
    return true
  }
  let excludedPaths = EXCLUDED_PATHS
  if (externallyExcludedPaths) {
    excludedPaths = [...excludedPaths, ...externallyExcludedPaths]
  }

  for (let i = 0; i < excludedPaths.length; i++) {
    if (filename.indexOf(excludedPaths[i]) > -1) {
      return true
    }
  }

  for (let i = 0; i < EXCLUDED_PATH_PREFIXES.length; i++) {
    if (filename.indexOf(EXCLUDED_PATH_PREFIXES[i]) === 0) {
      return true
    }
  }

  return false
}

function getFirstNonDDPathAndLine (externallyExcludedPaths) {
  return getFirstNonDDPathAndLineFromCallsites(getCallSiteInfo(), externallyExcludedPaths)
}
module.exports = pathLine
