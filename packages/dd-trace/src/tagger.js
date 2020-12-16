'use strict'

const log = require('./log')
const { toKeyValuePairs } = require('./util')

function add (carrier, keyValuePairs) {
  if (!carrier || !keyValuePairs) return

  if (typeof keyValuePairs === 'string') {
    return add(
      carrier,
      toKeyValuePairs(keyValuePairs)
    )
  }

  if (Array.isArray(keyValuePairs)) {
    return keyValuePairs.forEach(tags => add(carrier, tags))
  }

  try {
    Object.keys(keyValuePairs).forEach(key => {
      carrier[key] = keyValuePairs[key]
    })
  } catch (e) {
    log.error(e)
  }
}

module.exports = { add }
