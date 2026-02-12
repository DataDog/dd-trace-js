'use strict'

const path = require('path')
const process = require('process')
const { fileURLToPath } = require('url')
const { ddBasePath } = require('../../util')
const { getOriginalPathAndLineFromSourceMap } = require('./taint-tracking/rewriter')
const pathLine = {
  getNodeModulesPaths,
  getRelativePath,
  getCallSiteFramesForLocation,
  ddBasePath, // Exported only for test purposes
}

const EXCLUDED_PATHS = [
  path.join(path.sep, 'node_modules', 'dc-polyfill'),
]

/**
 * Processes and filters call site frames to find the best location for a vulnerability.
 * Returns client frames if available, otherwise falls back to all processed frames.
 * Excludes dd-trace frames and all Node.js built-in/internal modules (node:*).
 * @param {Array} callSiteFrames
 * @param {Array} externallyExcludedPaths
 * @returns {Array} Client frames if available, otherwise all processed frames
 */
function getCallSiteFramesForLocation (callSiteFrames, externallyExcludedPaths) {
  if (!callSiteFrames) {
    return []
  }

  const allFrames = []
  const clientFrames = []

  for (const callsite of callSiteFrames) {
    let filepath = callsite.file?.startsWith('file://') ? fileURLToPath(callsite.file) : callsite.file

    if (globalThis.__DD_ESBUILD_IAST_WITH_SM) {
      const callsiteLocation = {
        path: filepath,
        line: callsite.line,
        column: callsite.column,
      }
      const { path: originalPath, line, column } = getOriginalPathAndLineFromSourceMap(callsiteLocation)
      callsite.path = filepath = originalPath
      callsite.line = line
      callsite.column = column
    }

    if (filepath) {
      callsite.path = getRelativePath(filepath)
      callsite.isInternal = !path.isAbsolute(filepath)

      allFrames.push(callsite)

      if (
        !isExcluded(callsite, externallyExcludedPaths) &&
        (!filepath.includes(pathLine.ddBasePath) || globalThis.__DD_ESBUILD_IAST_WITH_NO_SM)
      ) {
        clientFrames.push(callsite)
      }
    }
  }

  return clientFrames.length > 0 ? clientFrames : allFrames
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

  if (filename.startsWith('node:')) {
    return true
  }

  for (const excludedPath of excludedPaths) {
    if (filename.includes(excludedPath)) {
      return true
    }
  }

  return false
}

function getNodeModulesPaths (...paths) {
  const nodeModulesPaths = []

  for (const p of paths) {
    const pathParts = p.split('/')
    nodeModulesPaths.push(path.join('node_modules', ...pathParts))
  }

  return nodeModulesPaths
}

module.exports = pathLine
