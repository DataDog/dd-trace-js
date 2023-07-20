'use strict'

let next = 0

function getNextSecureMark () {
  return 1 << next++
}

function reset () {
  next = 0
}

module.exports = { getNextSecureMark, reset }
