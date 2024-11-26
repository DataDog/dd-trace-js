'use strict'

/* eslint-disable no-var */

var guard = require('./packages/dd-trace/src/guardrails').guard

module.exports = guard(function () {
  return require('.').init()
})
