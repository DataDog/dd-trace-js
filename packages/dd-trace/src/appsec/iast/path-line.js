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
 * @param {CallSiteFrame[]} callSiteFrames
 * @param {string[]} externallyExcludedPaths
 * @returns {CallSiteFrame[]} Client frames if available, otherwise all processed frames
 *
 * @typedef {object} CallSiteFrame
 * @property {number} id
 * @property {string} file - Original file path
 * @property {number} line
 * @property {number} column
 * @property {string} function
 * @property {string} class_name
 * @property {boolean} isNative
 * @property {string} [path] - Relative path, added during processing
 * @property {boolean} [isInternal] - Whether the frame is internal, added during processing
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
  if (!filename || filename.startsWith('node:')) {
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
