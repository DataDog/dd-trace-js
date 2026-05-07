'use strict'

const assert = require('node:assert/strict')

const { debugChannel, errorChannel } = require('../../../packages/dd-trace/src/log/channels')
const log = require('../../../packages/dd-trace/src/log')

const { WITH_LEVEL = 'debug' } = process.env

// Skip `dd-trace.init()` for this micro-bench: we only want to measure the
// `log.<level>(...)` dispatch path, not full tracer startup. `log/index.js`
// calls `log.configure({})` at module load, which already reads
// `DD_TRACE_DEBUG` and `DD_TRACE_LOG_LEVEL` from env. Override the logger to
// no-ops so we measure dispatch + filtering rather than `console.log` cost.
log.configure({
  logger: {
    debug () {},
    info () {},
    warn () {},
    error () {},
  },
})

// Pre-flight sanity: confirm the channels match what the variant claims to
// measure. Catches the silent breakage where DD_TRACE_DEBUG / log API changes
// turn the bench into a no-op (channels never have subscribers regardless of
// variant).
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

for (let i = 0; i < 10_000_000; i++) {
  log[WITH_LEVEL](() => 'message')
}
