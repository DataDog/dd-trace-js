'use strict'

const path = require('path')
const process = require('process')
const { calculateDDBasePath } = require('../../util')
const pathLine = {
  getNodeModulesPaths,
  getRelativePath,
  getNonDDPathAndLineFromCallsites,
  calculateDDBasePath, // Exported only for test purposes
  ddBasePath: calculateDDBasePath(__dirname) // Only for test purposes
}

const EXCLUDED_PATHS = [
  path.join(path.sep, 'node_modules', 'dc-polyfill')
]
const EXCLUDED_PATH_PREFIXES = [
  'node:diagnostics_channel',
  'diagnostics_channel',
  'node:child_process',
  'child_process',
  'node:async_hooks',
  'async_hooks'
]

function getNonDDPathAndLineFromCallsites (callsites, externallyExcludedPaths) {
  if (!callsites) {
    return []
  }

  const result = []

  for (const callsite of callsites) {
    const filepath = callsite.getFileName()
    if (!isExcluded(callsite, externallyExcludedPaths) && filepath.indexOf(pathLine.ddBasePath) === -1) {
      callsite.column = callsite.getColumnNumber()
      callsite.line = callsite.getLineNumber()
      callsite.path = getRelativePath(filepath)
      callsite.isInternal = !path.isAbsolute(filepath)

      result.push(callsite)
    }
  }

  return result
}

function getRelativePath (filepath) {
  return path.relative(process.cwd(), filepath)
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

function getNodeModulesPaths (...paths) {
  const nodeModulesPaths = []

  paths.forEach(p => {
    const pathParts = p.split('/')
    nodeModulesPaths.push(path.join('node_modules', ...pathParts))
  })

  return nodeModulesPaths
}

module.exports = pathLine
