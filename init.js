'use strict'

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
