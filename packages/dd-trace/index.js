'use strict'

if (!global._ddtrace) {
  const TracerProxy = require('./src/proxy')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false
  })

  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
