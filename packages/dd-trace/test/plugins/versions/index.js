'use strict'

const { subset } = require('semver')
const latests = require('./package.json').dependencies
const supported = require('./supported.json')

const dir = 'packages/dd-trace/test/plugins/versions'
const exactVersionExp = /^=?\d+\.\d+\.\d+/

/**
 * @param {string} name
 * @param {string} range
 */
function getCappedRange (name, range) {
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
      `Latest version for '${name}' needs to be defined in '${dir}/package.json'.`
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

/**
 * @param {string} name
 * @param {string} subrange
 */
function assertSupported (name, subrange) {
  if (!supported[name]) {
    throw new Error(
      `Supported version range for '${name}' needs to be defined in '${dir}/supported.json'.`
    )
  }

  if (!subset(subrange, supported[name])) {
    throw new Error(
      `Version range '${subrange}' for '${name}' is lower than supported range defined in '${dir}/supported.json'.`
    )
  }
}

module.exports = {
  getCappedRange,
  assertSupported
}
