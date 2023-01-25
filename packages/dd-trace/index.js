'use strict'

if (!global._ddtrace) {
  const TracerProxy = require('./src')

  Object.defineProperty(global, '_ddtrace', {
    value: new TracerProxy(),
    enumerable: false,
    configurable: true,
    writable: true
  })

  global._ddtrace.default = global._ddtrace
  global._ddtrace.tracer = global._ddtrace
}

module.exports = global._ddtrace
