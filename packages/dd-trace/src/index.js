'use strict'

const { isFalse } = require('./util')

let inJestWorker = true
try {
  jest // eslint-disable-line no-undef
} catch (e) {
  inJestWorker = false // global `jest` is only present in Jest workers
}

module.exports = isFalse(process.env.DD_TRACE_ENABLED) || inJestWorker
  ? require('./noop/proxy')
  : require('./proxy')
