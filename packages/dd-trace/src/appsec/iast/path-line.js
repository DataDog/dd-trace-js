'use strict'

const path = require('path')
const process = require('process')
const { ddBasePath } = require('../../util')
const pathLine = {
  getNodeModulesPaths,
  getRelativePath,
  getNonDDCallSiteFrames,
  ddBasePath // Exported only for test purposes
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

function getNonDDCallSiteFrames (callSiteFrames, externallyExcludedPaths) {
  if (!callSiteFrames) {
    return []
  }

  const result = []

  for (const callsite of callSiteFrames) {
    const filepath = callsite.file
    if (!isExcluded(callsite, externallyExcludedPaths) && !filepath.includes(pathLine.ddBasePath)) {
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
  if (callsite.isNative) return true
  const filename = callsite.file
  if (!filename) {
    return true
  }
  let excludedPaths = EXCLUDED_PATHS
  if (externallyExcludedPaths) {
    excludedPaths = [...excludedPaths, ...externallyExcludedPaths]
  }

  for (const excludedPath of excludedPaths) {
    if (filename.includes(excludedPath)) {
      return true
    }
  }

  for (const EXCLUDED_PATH_PREFIX of EXCLUDED_PATH_PREFIXES) {
    if (filename.indexOf(EXCLUDED_PATH_PREFIX) === 0) {
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
