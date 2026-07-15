'use strict'

module.exports = function (a, b) {
  const localVar = 1
  const users = []
  const metadata = {}
  if (a > 10) {
    throw new Error('a is too big')
  }
  return a + b + localVar + users.length + Object.keys(metadata).length // location of the breakpoint
}
