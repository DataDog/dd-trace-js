'use strict'

function funSum (a, b) {
  const localVariable = 2
  if (a > 10) {
    throw new Error('the number is too big')
  }

  return a + b + localVariable
}

module.exports = funSum
