'use strict'

module.exports = function (a, b) {
  const localVariable = 2
  if (a > 10) {
    throw new Error('a is too big')
  }
  return a + b + localVariable - localVariable
}
