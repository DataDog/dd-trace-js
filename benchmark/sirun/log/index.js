'use strict'

const log = require('../../../packages/dd-trace/src/log')

const {
  DD_TRACE_DEBUG = 'true',
  ITERATIONS = 1000,
  WITH_LEVEL = 'debug'
} = process.env

require('../../..').init({
  debug: DD_TRACE_DEBUG
})

log.use({
  debug () {},
  info () {},
  warn () {},
  error () {}
})

for (let i = 0; i < ITERATIONS; i++) {
  log[WITH_LEVEL](() => 'message')
}
