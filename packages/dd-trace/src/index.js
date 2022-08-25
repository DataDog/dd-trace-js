'use strict'

const { isFalse } = require('./util')

module.exports = isFalse(process.env.DD_TRACE_ENABLED)
  ? require('./noop/proxy')
  : require('./proxy')
