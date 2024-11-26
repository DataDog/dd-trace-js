'use strict'

/* eslint-disable no-var */
/* eslint-disable no-console */

var isTrue = require('./util').isTrue

var DD_TRACE_DEBUG = process.env.DD_TRACE_DEBUG
var DD_TRACE_LOG_LEVEL = process.env.DD_TRACE_LOG_LEVEL

var logLevels = {
  trace: 20,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  critical: 50,
  off: 100
}

var logLevel = isTrue(DD_TRACE_DEBUG)
  ? Number(DD_TRACE_LOG_LEVEL) || logLevels.debug
  : logLevels.off

var log = {
  debug: logLevel <= 20 ? console.debug.bind(console) : function () {},
  info: logLevel <= 30 ? console.info.bind(console) : function () {},
  warn: logLevel <= 40 ? console.warn.bind(console) : function () {},
  error: logLevel <= 50 ? console.error.bind(console) : function () {}
}

module.exports = log
