'use strict'

module.exports = function (a, b) {
  // eslint-disable-next-line no-console
  console.log('running yo')
  const localVar = 1
  // debugger
  if (a > 10) {
    throw new Error('a is too big')
  }
  return a + b + localVar // location of the breakpoint
}
