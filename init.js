'use strict'

var applyPm2Env = require('./packages/dd-trace/src/guardrails/apply-pm2-env')
applyPm2Env()

var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
