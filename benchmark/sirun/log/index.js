'use strict'

const log = require('../../../packages/dd-trace/src/log')

const {
  ITERATIONS = 1000,
  TEST_LEVEL = 'debug'
} = process.env

require('../../..').init()

log.use({
  debug () {},
  info () {},
  warn () {},
  error () {}
})

for (let i = 0; i < ITERATIONS; i++) {
  log[TEST_LEVEL](() => 'message')
}
