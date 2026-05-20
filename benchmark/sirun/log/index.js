'use strict'

const assert = require('node:assert/strict')

const { debugChannel, errorChannel } = require('../../../packages/dd-trace/src/log/channels')
const log = require('../../../packages/dd-trace/src/log')

const { WITH_LEVEL = 'debug' } = process.env

// Override the default console-backed logger to isolate dispatch + filtering cost.
log.configure({
  logger: {
    debug () {},
    info () {},
    warn () {},
    error () {},
  },
})

const debugLevel = process.env.DD_TRACE_LOG_LEVEL ?? 'debug'
const debugEnabled = process.env.DD_TRACE_DEBUG === 'true'
assert.equal(
  debugChannel.hasSubscribers,
  debugEnabled && (debugLevel === 'trace' || debugLevel === 'debug'),
  `debugChannel.hasSubscribers mismatch (DD_TRACE_DEBUG=${process.env.DD_TRACE_DEBUG}, level=${debugLevel})`
)
assert.equal(
  errorChannel.hasSubscribers,
  debugEnabled,
  `errorChannel.hasSubscribers mismatch (DD_TRACE_DEBUG=${process.env.DD_TRACE_DEBUG})`
)

for (let i = 0; i < 1_000_000; i++) {
  log[WITH_LEVEL](() => 'message')
}
