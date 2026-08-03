'use strict'

const fs = require('node:fs')
const path = require('node:path')

const log = require('../log')

const BIGINT_LSTAT_OPTIONS = { bigint: true, throwIfNoEntry: false }

/**
 * Coverage report file patterns to search for
 * Each entry contains the relative path from root and the format identifier
 */
const COVERAGE_REPORT_PATTERNS = [
  // LCOV format
  { path: 'coverage/lcov.info', format: 'lcov' },
  { path: 'lcov.info', format: 'lcov' },

  // Cobertura XML format
  { path: 'coverage/cobertura-coverage.xml', format: 'cobertura' },
  { path: 'cobertura-coverage.xml', format: 'cobertura' },

  // JaCoCo XML format
  { path: 'coverage/jacoco.xml', format: 'jacoco' },
  { path: 'jacoco.xml', format: 'jacoco' },

  // Clover XML format
  { path: 'coverage/clover.xml', format: 'clover' },
  { path: 'clover.xml', format: 'clover' },

  // OpenCover XML format
  { path: 'coverage/opencover.xml', format: 'opencover' },
  { path: 'opencover.xml', format: 'opencover' },

  // SimpleCov JSON format
  { path: 'coverage/.resultset.json', format: 'simplecov' },
  { path: '.resultset.json', format: 'simplecov' },
]

/**
 * Discovers code coverage report files in the given root directory
 * @param {string} rootDir - The root directory to search for coverage reports
 * @returns {Array<{filePath: string, fileDevice: bigint, fileInode: bigint, format: string}>}
 */
function discoverCoverageReports (rootDir) {
  if (!rootDir) {
    log.debug('No root directory provided for coverage report discovery')
    return []
  }

  let resolvedRoot
  try {
    const unresolvedRoot = path.resolve(rootDir)
    const rootStats = fs.lstatSync(unresolvedRoot, BIGINT_LSTAT_OPTIONS)
    if (rootStats?.isSymbolicLink() || !rootStats?.isDirectory()) {
      log.debug('Coverage report root is not a regular directory: %s', unresolvedRoot)
      return []
    }
    resolvedRoot = fs.realpathSync(unresolvedRoot)
    const resolvedRootStats = fs.lstatSync(resolvedRoot, BIGINT_LSTAT_OPTIONS)
    if (!resolvedRootStats || resolvedRootStats.dev !== rootStats.dev || resolvedRootStats.ino !== rootStats.ino) {
      log.debug('Coverage report root changed while resolving it: %s', unresolvedRoot)
      return []
    }
  } catch (error) {
    log.debug('Error checking coverage report root %s: %s', rootDir, error.message)
    return []
  }

  const discoveredReports = []

  for (const pattern of COVERAGE_REPORT_PATTERNS) {
    let currentPath = resolvedRoot

    try {
      let stats
      for (const pathSegment of pattern.path.split('/')) {
        currentPath = path.join(currentPath, pathSegment)
        stats = fs.lstatSync(currentPath, BIGINT_LSTAT_OPTIONS)
        if (!stats || stats.isSymbolicLink()) break
      }

      // A hard link can name a file outside the root without changing its real path.
      if (stats?.isFile() && stats.nlink === 1n) {
        const resolvedPath = fs.realpathSync(currentPath)
        const pathFromRoot = path.relative(resolvedRoot, resolvedPath)
        if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromRoot)) {
          log.debug('Coverage report resolved outside the root directory: %s', currentPath)
          continue
        }
        discoveredReports.push({
          filePath: resolvedPath,
          fileDevice: stats.dev,
          fileInode: stats.ino,
          format: pattern.format,
        })
        log.debug('Found coverage report: %s (format: %s)', resolvedPath, pattern.format)
      }
    } catch (error) {
      // Log but don't fail if we can't access a file
      log.debug('Error checking coverage report path %s: %s', currentPath, error.message)
    }
  }

  if (discoveredReports.length === 0) {
    log.debug('No coverage reports found in %s', rootDir)
  } else {
    log.debug('Discovered %d coverage report(s)', discoveredReports.length)
  }

  return discoveredReports
}

module.exports = { discoverCoverageReports }
