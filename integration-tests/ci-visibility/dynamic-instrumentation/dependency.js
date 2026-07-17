'use strict'

module.exports = function (a, b) {
  const [localVariable, emptyObject, emptyArray, emptyMap] = [2, {}, [], new Map()]
  if (a > 10) {
    throw new Error('a is too big')
  }
  return a + b + localVariable - localVariable + Object.keys(emptyObject).length + emptyArray.length + emptyMap.size
}
