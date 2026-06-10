'use strict'

const assert = require('node:assert/strict')

const { debugChannel, errorChannel } = require('../../../packages/dd-trace/src/log/channels')
const log = require('../../../packages/dd-trace/src/log')

const { WITH_LEVEL = 'debug' } = process.env
const COUNT = 800_000

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

// The disabled / filtered variants (without-log, skip-log) are node-boot-bound:
// the disabled path is a near-free dispatch, and lengthening only trades boot
// domination for a closure-allocation GC cliff (an inline thunk per call), while
// hoisting the thunk lets V8 dead-code-eliminate the no-op loop. They are left
// short; with-debug / with-error are the loop-dominant variants. No startup guard
// for that reason.
for (let i = 0; i < COUNT; i++) {
  log[WITH_LEVEL](() => 'message')
}
