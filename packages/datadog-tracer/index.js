'use strict'

const { DD_TRACE_ENABLED } = process.env
const { tracer } = DD_TRACE_ENABLED !== 'false'
  ? require('./src/tracer')
  : require('./src/noop')

module.exports = { tracer }
