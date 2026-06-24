'use strict'

/**
 * Parses the Node.js major-version bounds from the package engines range.
 *
 * @param {string} range The package.json engines.node range.
 * @returns {{ minMajor: number, maxMajor: number | undefined }}
 */
function parseNodeRange (range) {
  var min = range.match(/(?:^|\s)>=\s*(\d+)/)
  var max = range.match(/(?:^|\s)<\s*(\d+)/)

  if (!min) {
    // eslint-disable-next-line n/no-unsupported-features/es-builtins
    throw new Error('Unsupported engines.node range: ' + range)
  }

  return {
    minMajor: Number(min[1]),
    maxMajor: max ? Number(max[1]) : undefined
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

  return major >= parsed.minMajor &&
    (parsed.maxMajor === undefined || major < parsed.maxMajor)
}

module.exports = {
  isNodeRangeSupported: isNodeRangeSupported,
  parseNodeRange: parseNodeRange
}
