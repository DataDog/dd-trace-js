'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

const { debugChannel, errorChannel } = require('../../../packages/dd-trace/src/log/channels')
const log = require('../../../packages/dd-trace/src/log')

const { WITH_LEVEL = 'debug' } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

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
// OPERATIONS is set per variant (meta.json): with-error stays at 800k because the per-call
// Error allocation hits a major-GC cliff that spikes stddev if grown; with-debug has
// no such allocation, so it runs a larger OPERATIONS to keep the loop well clear of the
// startup-guard floor and tighten per-sample stddev. The earlier disabled/filtered
// variants (no subscribers) were dropped: with nothing to dispatch to, V8 dead-code-
// eliminated the no-op loop, so wall.time flipped between running and elided runs
// (stddev up to ~66%) and the variant measured nothing that could regress.
guard.loopStart()
for (let i = 0; i < OPERATIONS; i++) {
  log[WITH_LEVEL](() => 'message')
}
guard.done()
