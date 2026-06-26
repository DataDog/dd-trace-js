'use strict'

const assert = require('node:assert/strict')
const guard = require('../startup-guard')

// Require the real fs instrumentation so its diagnostic channels exist and fs is
// wrapped exactly as in production. We then drive the per-call wrapper overhead
// without touching the disk: a no-op underlying op isolates the tracer's added
// cost (orphan guard, getMessage-shape ctx build, AbortController, runStores x2)
// from filesystem syscall noise.
require('../../../packages/datadog-instrumentations/src/fs')
const { channel } = require('../../../packages/datadog-instrumentations/src/helpers/instrument')

const { VARIANT } = process.env
const OPERATIONS = Number(process.env.OPERATIONS)

const startChannel = channel('apm:fs:operation:start')
const finishChannel = channel('apm:fs:operation:finish')
const errorChannel = channel('apm:fs:operation:error')

// statSync-shaped params: the common fs op is a single-path stat/read.
const PARAMS = ['path', 'options']
const ARGS = ['/var/app/data/file.txt', { encoding: 'utf8' }]

// Mirrors fs.js getMessage: build the per-call metadata object.
function getMessage (operation, params, args) {
  const metadata = {}
  for (let i = 0; i < params.length; i++) {
    if (!params[i] || typeof args[i] === 'function') continue
    metadata[params[i]] = args[i]
  }
  return { operation, ...metadata }
}

// Mirrors the sync (no-callback) branch of createWrapFunction: orphan guard, ctx
// build with AbortController, the always-allocated per-call finish closure, the
// signal.aborted check, and the try/catch that publishes error/finish around the op.
// Skipping those would under-report the always-executed wrapper control flow.
function instrumentedCall () {
  if (!startChannel.hasSubscribers) return 0
  const lastIndex = ARGS.length - 1
  const cb = typeof ARGS[lastIndex] === 'function' && ARGS[lastIndex]
  const abortController = new AbortController()
  const ctx = { ...getMessage('statSync', PARAMS, ARGS), abortController }

  const finish = function (error, callback = () => {}) {
    if (error !== null && typeof error === 'object') {
      ctx.error = error
      errorChannel.publish(ctx)
    }
    return finishChannel.runStores(ctx, callback)
  }

  return startChannel.runStores(ctx, () => {
    if (abortController.signal.aborted) {
      const error = abortController.signal.reason || new Error('Aborted')
      finish(error)
      throw error
    }
    try {
      const result = 1 // no-op underlying op: no syscall
      if (cb) return result
      finishChannel.runStores(ctx, () => {})
      return result
    } catch (error) {
      ctx.error = error
      errorChannel.publish(ctx)
      finishChannel.runStores(ctx, () => {})
      throw error
    }
  })
}

if (VARIANT === 'subscribed') {
  startChannel.subscribe(() => {})
  finishChannel.subscribe(() => {})
}

assert.equal(VARIANT === 'subscribed', startChannel.hasSubscribers,
  'subscriber state does not match variant')

// Drift guard: getMessage + the wrapper body mirror fs.js (neither is exported), so
// assert the mirror still produces the production per-call message shape -- otherwise
// a refactor on either side diverges silently while the loop keeps "passing".
assert.deepEqual(
  getMessage('statSync', PARAMS, ARGS),
  { operation: 'statSync', path: '/var/app/data/file.txt', options: { encoding: 'utf8' } },
  'getMessage mirror drifted from the fs.js per-call message shape'
)

guard.loopStart()
let sink = 0
for (let i = 0; i < OPERATIONS; i++) {
  sink += instrumentedCall()
}
guard.done()

// orphan-guard variant returns 0 each call; subscribed returns 1.
assert.equal(sink, VARIANT === 'subscribed' ? OPERATIONS : 0, 'unexpected sink')
