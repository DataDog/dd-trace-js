'use strict'

if (!process._ddtrace) {
  const TracerProxy = require('./src/proxy')

  process._ddtrace = new TracerProxy()
  process._ddtrace.default = process._ddtrace
  process._ddtrace.tracer = process._ddtrace
}

module.exports = process._ddtrace
