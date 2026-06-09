'use strict'

const assert = require('node:assert/strict')

const { debugChannel, errorChannel } = require('../../../packages/dd-trace/src/log/channels')
const log = require('../../../packages/dd-trace/src/log')

const { WITH_LEVEL = 'debug' } = process.env
const COUNT = Number(process.env.COUNT) || 800_000

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

// Both variants drive the logger on every call, so the loop dominates: with-debug
// runs the (overridden no-op) debug handler, with-error builds an Error per call.
// COUNT stays at 800k because with-error allocates an Error + message per iteration;
// growing it hits a major-GC cliff that spikes stddev. The earlier disabled/filtered
// variants (no subscribers) were dropped: with nothing to dispatch to, V8 dead-code-
// eliminated the no-op loop, so wall.time flipped between running and elided runs
// (stddev up to ~66%) and the variant measured nothing that could regress.
for (let i = 0; i < COUNT; i++) {
  log[WITH_LEVEL](() => 'message')
}
