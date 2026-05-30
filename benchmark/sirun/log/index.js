'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

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

// The disabled/filtered path (without-log, skip-log) is ~8 ns/call, so it needs a
// far larger count than the emitting path to outrun node boot; set per variant.
const COUNT = Number(process.env.COUNT) || 1_000_000

guard.loopStart()
for (let i = 0; i < COUNT; i++) {
  log[WITH_LEVEL](() => 'message')
}
guard.done()
