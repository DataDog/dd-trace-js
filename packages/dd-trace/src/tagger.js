'use strict'

const log = require('./log')

function addNonEmpty (carrier, key, value) {
  if (key !== '') {
    carrier[key] = value
  }
}

function add (carrier, keyValuePairs) {
  if (!carrier) return

  try {
    if (typeof keyValuePairs === 'string') {
      let valueStart = 0
      let keyStart = 0

      for (let i = 0; i < keyValuePairs.length; i++) {
        const char = keyValuePairs[i]

        if (char === ':') {
          if (valueStart === 0) {
            valueStart = i
          }
        } else if (char === ',') {
          valueStart ||= i
          addNonEmpty(
            carrier,
            keyValuePairs.slice(keyStart, valueStart).trim(),
            keyValuePairs.slice(valueStart + 1, i).trim()
          )
          keyStart = i + 1
          valueStart = 0
        }
      }

      if (keyValuePairs.at(-1) !== ',') {
        valueStart ||= keyValuePairs.length
        addNonEmpty(
          carrier,
          keyValuePairs.slice(keyStart, valueStart).trim(),
          keyValuePairs.slice(valueStart + 1).trim()
        )
      }
    } else if (Array.isArray(keyValuePairs)) {
      return keyValuePairs.forEach(tags => add(carrier, tags))
    } else {
      Object.assign(carrier, keyValuePairs)
    }
  } catch (error) {
    log.error('Error adding tags', error)
  }
}

module.exports = { add }
