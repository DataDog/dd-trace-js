'use strict'

/**
 * Parses the Node.js major-version bounds from the package engines range.
 *
 * @param {string} range The package.json engines.node range.
 * @returns {{ minMajor: number, maxMajor: number }}
 */
function parseNodeRange (range) {
  var versions = range.match(/^>=\s*(\d+)\s+<\s*(\d+)$/)

  if (!versions) {
    // eslint-disable-next-line n/no-unsupported-features/es-builtins
    throw new Error('Unsupported engines.node range: ' + range)
  }

  return {
    minMajor: Number(versions[1]),
    maxMajor: Number(versions[2])
  }
}

/**
 * Checks whether a Node.js major version is supported by the package engines range.
 *
 * @param {number} major The Node.js major version.
 * @param {string} range The package.json engines.node range.
 * @returns {boolean}
 */
function isNodeRangeSupported (major, range) {
  var parsed = parseNodeRange(range)

  return major >= parsed.minMajor && major < parsed.maxMajor
}

module.exports = {
  isNodeRangeSupported: isNodeRangeSupported,
  parseNodeRange: parseNodeRange
}
