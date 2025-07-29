'use strict'

const latests = require('./package.json').dependencies

/**
 * @param {string} name
 * @param {string} range
 */
function getCappedRange (name, range) {
  const alreadyCapped = range.split('||').every(r => {
    return r.includes('-') || r.includes('<') || /^=?\d+\.\d+\.\d+$/.test(r)
  })

  if (alreadyCapped) return range
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
