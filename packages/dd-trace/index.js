'use strict'

if (!global._ddtrace) {
  const TracerProxy = require('./src/proxy')

  global._ddtrace = new TracerProxy()
  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
