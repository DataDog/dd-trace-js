'use strict'

const { isFalse } = require('./util')

module.exports = isFalse(process.env.DD_TRACE_ENABLED) || global.jest
  ? require('./noop/proxy')
  : require('./proxy')
