'use strict'

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

function isError (value) {
  if (value instanceof Error) {
    return true
  }
  if (value && value.constructor) {
    return value.constructor.name === 'JestAssertionError' ||
      value.constructor.name === 'Error' ||
      value.constructor.name === 'ErrorWithStack'
  }
  return false
}

module.exports = {
  isTrue,
  isFalse,
  isError
}
