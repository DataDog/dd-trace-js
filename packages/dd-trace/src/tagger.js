'use strict'

const log = require('./log')

function chooseSeparator (keyValuePairs) {
  const tagSeparatorCount = keyValuePairs.split(':').length - 1
  for (const separator of [',', ' ']) {
    const segments = keyValuePairs.split(separator)
    // The separator is chosen if number of split segments 
    // equals number of counted colons
    if (segments.length === tagSeparatorCount) {
      return separator
    }
  }
  // fallback on legacy behaviour and return comma
  return ','
}

function add (carrier, keyValuePairs) {
  if (!carrier || !keyValuePairs) return

  if (Array.isArray(keyValuePairs)) {
    return keyValuePairs.forEach(tags => add(carrier, tags))
  }

  try {
    if (typeof keyValuePairs === 'string') {
      const chosenSeparator = chooseSeparator(keyValuePairs)
      const segments = keyValuePairs.split(chosenSeparator)

      for (const segment of segments) {
        const separatorIndex = segment.indexOf(':')
        if (separatorIndex === -1) continue

        const key = segment.slice(0, separatorIndex)
        const value = segment.slice(separatorIndex + 1)

        carrier[key.trim()] = value.trim()
      }
    } else {
      Object.assign(carrier, keyValuePairs)
    }
  } catch (e) {
    log.error(e)
  }
}

module.exports = { add }
