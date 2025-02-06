'use strict'

module.exports = function (a, b) {
  const localVar = 1
  if (a > 10) {
    throw new Error('a is too big')
  }
  return a + b + localVar // location of the breakpoint
}
