'use strict'

// require('time-require')

/* eslint-disable no-var */

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
