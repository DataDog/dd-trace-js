'use strict'

const log = require('./log')
const { extractJustTags, extractError } = require('./format')

function addToObject (carrier, keyValuePairs) {
  Object.keys(keyValuePairs).forEach(key => {
    carrier[key] = keyValuePairs[key]
  })
}

function add (carrier, keyValuePairs, baseAdd = addToObject) {
  if (!carrier || !keyValuePairs) return

  if (typeof keyValuePairs === 'string') {
    return add(
      carrier,
      keyValuePairs
        .split(',')
        .filter(tag => tag.indexOf(':') !== -1)
        .reduce((prev, next) => {
          const tag = next.split(':')
          const key = tag[0]
          const value = tag.slice(1).join(':')

          prev[key] = value

          return prev
        }, {})
    )
  }

  if (Array.isArray(keyValuePairs)) {
    return keyValuePairs.forEach(tags => add(carrier, tags))
  }

  try {
    baseAdd(carrier, keyValuePairs)
  } catch (e) {
    log.error(e)
  }
}

function addToSpanContext (spanContext, keyValuePairs) {
  add(spanContext._spanData, keyValuePairs, (spanData, tags) => {
    extractError(spanData, tags)
    extractJustTags(spanData, tags)
  })
}

module.exports = { add, addToSpanContext }
