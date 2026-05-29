'use strict'

const assert = require('node:assert/strict')

// Require the real fs instrumentation so its diagnostic channels exist and fs is
// wrapped exactly as in production. We then drive the per-call wrapper overhead
// without touching the disk: a no-op underlying op isolates the tracer's added
// cost (orphan guard, getMessage-shape ctx build, AbortController, runStores x2)
// from filesystem syscall noise.
require('../../../packages/datadog-instrumentations/src/fs')
const { channel } = require('../../../packages/datadog-instrumentations/src/helpers/instrument')

const { VARIANT } = process.env
const ITERATIONS = Number(process.env.ITERATIONS) || 6_000_000

const startChannel = channel('apm:fs:operation:start')
const finishChannel = channel('apm:fs:operation:finish')

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

// Mirrors the sync (no-callback) branch of createWrapFunction: orphan guard,
// ctx build with AbortController, runStores around the op, finishChannel.
function instrumentedCall () {
  if (!startChannel.hasSubscribers) return 0
  const abortController = new AbortController()
  const ctx = { ...getMessage('statSync', PARAMS, ARGS), abortController }
  return startChannel.runStores(ctx, () => {
    const result = 1 // no-op underlying op: no syscall
    finishChannel.runStores(ctx, () => {})
    return result
  })
}

if (VARIANT === 'subscribed') {
  startChannel.subscribe(() => {})
  finishChannel.subscribe(() => {})
}

assert.equal(VARIANT === 'subscribed', startChannel.hasSubscribers,
  'subscriber state does not match variant')

let sink = 0
for (let i = 0; i < ITERATIONS; i++) {
  sink += instrumentedCall()
}

// orphan-guard variant returns 0 each call; subscribed returns 1.
assert.equal(sink, VARIANT === 'subscribed' ? ITERATIONS : 0, 'unexpected sink')
