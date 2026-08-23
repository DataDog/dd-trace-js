'use strict'

const UNSAFE_FILE_CHARACTERS = /[^a-zA-Z0-9_.-]+/g

/**
 * Convert a test suite identifier into a portable filename segment.
 *
 * @param {string} name test suite identifier
 * @returns {string} portable filename segment
 */
function sanitizeName (name) {
  return name.replaceAll(UNSAFE_FILE_CHARACTERS, '-').replaceAll(/^-+|-+$/g, '') || 'unnamed'
}

/**
 * Return a unique JUnit output path for a suite and Node.js version.
 *
 * @param {string} suiteName test suite identifier
 * @param {string} [nodeVersion] Node.js version running the suite
 * @returns {string} JUnit output path
 */
function getJunitFile (suiteName, nodeVersion = process.versions.node) {
  return `./node-${sanitizeName(nodeVersion)}-${sanitizeName(suiteName)}-junit.xml`
}

module.exports = { getJunitFile, sanitizeName }
