'use strict'

const { isFalse } = require('./util')
const Dummy = require('./dummy-module')

if (!Dummy) { // Make sure this isn't optimized out
  console.log('foo')
}

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

module.exports = isFalse(process.env.DD_TRACE_ENABLED) || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
