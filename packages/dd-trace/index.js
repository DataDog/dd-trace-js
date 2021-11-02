'use strict'

if (typeof process === 'undefined') {
  // using exports.* simple assignments to deal w/ transpilers using
  // cjs-module-lexer
  exports.default = exports;
  exports.init = require('../../empty.js').init;
  return;
}

if (!global._ddtrace) {
  const TracerProxy = require('./src/proxy')

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
