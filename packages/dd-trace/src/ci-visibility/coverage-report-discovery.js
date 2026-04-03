'use strict'

const fs = require('node:fs')
const path = require('node:path')

const log = require('../log')

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
 * @returns {Array<{filePath: string, format: string}>} Array of discovered coverage reports
 */
function discoverCoverageReports (rootDir) {
  if (!rootDir) {
    log.debug('No root directory provided for coverage report discovery')
    return []
  }

  const discoveredReports = []

  for (const pattern of COVERAGE_REPORT_PATTERNS) {
    const fullPath = path.join(rootDir, pattern.path)

    try {
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath)

        // Only include regular files, not directories or symlinks
        if (stats.isFile()) {
          discoveredReports.push({
            filePath: fullPath,
            format: pattern.format,
          })
          log.debug('Found coverage report: %s (format: %s)', fullPath, pattern.format)
        }
      }
    } catch (err) {
      // Log but don't fail if we can't access a file
      log.debug('Error checking coverage report path %s: %s', fullPath, err.message)
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
