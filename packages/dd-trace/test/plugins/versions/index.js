'use strict'

const { subset } = require('semver')
const latests = require('./package.json').dependencies

const exactVersionExp = /^=?\d+\.\d+\.\d+/

/**
 * @param {string} name
 * @param {string} range
 */
function getCappedRange (name, range) {
  if (exactVersionExp.test(range)) return range

  return range
    .split('||')
    .map(sub => capSubrange(name, sub.trim()))
    .join(' || ')
}

/**
 * @param {string} name
 * @param {string} subrange
 */
function capSubrange (name, subrange) {
  if (exactVersionExp.test(subrange)) return subrange

  if (!latests[name]) {
    throw new Error(
      `Latest version for '${name}' needs to be defined in 'packages/dd-trace/test/plugins/versions/package.json'.`
    )
  }

  if (!subrange || subrange === 'latest') return latests[name]
  if (subset(subrange, `<=${latests[name]}`)) return subrange
  if (subrange.includes(' - ')) {
    const minRange = subrange.split(' - ')[0].trim()

    return `${minRange} - ${latests[name]}`
  }

  return `${subrange} <=${latests[name]}`
}

module.exports = {
  getCappedRange
}
