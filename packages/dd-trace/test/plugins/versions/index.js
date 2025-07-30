'use strict'

const { subset } = require('semver')
const latests = require('./package.json').dependencies

/**
 * @param {string} name
 * @param {string} range
 */
function getCappedRange (name, range) {
  const subranges = range.split('||')
  const alreadyCapped = subranges.every(r => /^=?\d+\.\d+\.\d+$/.test(r))

  let cappedRanges = []

  for (const subrange in subranges) {
    if (/^=?\d+\.\d+\.\d+$/.test(subrange)) {
      cappedRanges.push(subrange)
      continue
    }

    if (!latests[name]) {
      throw new Error(
        `Latest version for '${name}' needs to be defined in 'packages/dd-trace/test/plugins/versions/package.json'.`
      )
    }

    if (subrange.includes('-')) {
      const parts = subrange.split('-').map(p => p.trim())

      if (subset(parts[1], `<=${latests[name]}`)) {
        cappedRanges.push(subrange)
      } else {
        cappedRanges.push(`${parts[0]} - ${latests[name]}`)
      }
    } else {
      cappedRanges.push(subrange ? `${subrange} <=${latests[name]}` : latests[name])
    }
  }

  return cappedRanges.join(' || ')
}

module.exports = {
  getCappedRange
}
