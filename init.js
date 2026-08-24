'use strict'

require('./packages/dd-trace/src/guardrails/apply-pm2-env')

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
