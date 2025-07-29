'use strict'

const latests = require('./package.json').dependencies

/**
 * @param {string} name
 * @param {string} range
 * @param {boolean} [external=false]
 */
function getCappedRange (name, range, external = false) {
  const alreadyCapped = range.includes('-')

  if (external || alreadyCapped) return range
  if (!latests[name]) {
    throw new Error(
      `Latest version for '${name}' needs to be defined in 'packages/dd-trace/test/plugins/versions/package.json'.`
    )
  }

  return `${range} <=${latests[name]}`
}

module.exports = {
  getCappedRange
}
