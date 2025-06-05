'use strict'

/* eslint-disable no-var */

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  var INSTRUMENTED_BY_SSI = require('./packages/dd-trace/src/constants').INSTRUMENTED_BY_SSI
  return require('.').init({ [INSTRUMENTED_BY_SSI]: 'ssi' })
})
