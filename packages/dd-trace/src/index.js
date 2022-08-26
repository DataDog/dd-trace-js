'use strict'

const { isFalse } = require('./util')

// Global `jest` is only present in Jest workers.
const inJestWorker = typeof jest !== 'undefined'

module.exports = isFalse(process.env.DD_TRACE_ENABLED) || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
