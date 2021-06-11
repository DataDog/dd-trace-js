'use strict'

function isTrue (str) {
  str = String(str).toLowerCase()
  return str === 'true' || str === '1'
}

function isFalse (str) {
  str = String(str).toLowerCase()
  return str === 'false' || str === '0'
}

// from https://github.com/facebook/jest/blob/d1882f2e6033186bd310240add41ffe50c2a9259/packages/expect/src/utils.ts#L350
function isError (value) {
  switch (Object.prototype.toString.call(value)) {
    case '[object Error]':
    case '[object Exception]':
    case '[object DOMException]':
      return true
    default:
      return value instanceof Error
  }
}

module.exports = {
  isTrue,
  isFalse,
  isError
}
