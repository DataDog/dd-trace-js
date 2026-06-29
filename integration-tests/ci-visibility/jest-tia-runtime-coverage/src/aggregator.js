'use strict'

const { multiply } = require('./math')
const { sharedLabel } = require('./shared')

function aggregate (name) {
  return `${sharedLabel(name)}:${multiply(2, 4)}`
}

module.exports = { aggregate }
