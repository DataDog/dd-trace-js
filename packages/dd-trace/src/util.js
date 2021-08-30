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
  if (value && value.message && value.stack) {
    return true
  }
  return false
}

// Inspired by https://github.com/doowb/koalas
function coalesce (...args) {
  let arg
  for (const nextArg of args) {
    arg = nextArg
    if (arg !== null && arg !== undefined && !Number.isNaN(arg)) {
      return arg
    }
  }
  return arg
}

module.exports = {
  isTrue,
  isFalse,
  isError,
  coalesce
}
