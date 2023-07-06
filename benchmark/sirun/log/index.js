'use strict'

const log = require('../../../packages/dd-trace/src/log')

const {
  DD_TRACE_DEBUG = 'true',
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

for (let i = 0; i < 1000000000; i++) {
  log[WITH_LEVEL](() => 'message')
}
