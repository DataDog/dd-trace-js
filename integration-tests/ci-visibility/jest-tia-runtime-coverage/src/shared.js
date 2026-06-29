'use strict'

const { add } = require('./math')

function sharedLabel (name) {
  return `${name}:${add(1, 2)}`
}

module.exports = { sharedLabel }
