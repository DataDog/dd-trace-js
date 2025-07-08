'use strict'

/* eslint-disable no-var */

// TODO: It shouldn't be necessary to disable n/no-unpublished-require - Research
// eslint-disable-next-line n/no-unpublished-require
var guard = require('./packages/dd-trace/src/guardrails')

module.exports = guard(function () {
  return require('.').init()
})
