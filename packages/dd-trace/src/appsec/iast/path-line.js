'use strict'

const path = require('path')
const process = require('process')
const { ddBasePath } = require('../../util')
const { getOriginalPathAndLineFromSourceMap } = require('./taint-tracking/rewriter')
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
    let filepath = callsite.file

    if (globalThis.__DD_ESBUILD_IAST_WITH_SM) {
      const callsiteLocation = {
        path: getRelativePath(filepath),
        line: callsite.line,
        column: callsite.column
      }
      const { path: originalPath, line, column } = getOriginalPathAndLineFromSourceMap(callsiteLocation)
      callsite.path = filepath = originalPath
      callsite.line = line
      callsite.column = column
    }

    if (
      !isExcluded(callsite, externallyExcludedPaths) &&
      (!filepath.includes(pathLine.ddBasePath) || globalThis.__DD_ESBUILD_IAST_WITH_NO_SM)
    ) {
      callsite.path = getRelativePath(filepath)
      callsite.isInternal = !path.isAbsolute(filepath)

      result.push(callsite)
    }
  }

  return result
}

function getRelativePath (filepath) {
  return filepath && path.relative(process.cwd(), filepath)
}

function isExcluded (callsite, externallyExcludedPaths) {
  if (callsite.isNative) return true
  const filename = globalThis.__DD_ESBUILD_IAST_WITH_SM ? callsite.path : callsite.file
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
