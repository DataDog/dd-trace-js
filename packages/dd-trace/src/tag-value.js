'use strict'

const log = require('./log')

let hasWarned = false

/**
@param {unknown} value
@param {string} key */
function stringifyTagValue (value, key) {
  const text = String(value)
  if (!hasWarned && text === '[object Object]' && typeof value !== 'string') {
    hasWarned = true
    log.warn('Tag "%s" was converted to "[object Object]". Pass a string or use a meaningful string conversion.', key)
  }
  return text
}

module.exports = stringifyTagValue
