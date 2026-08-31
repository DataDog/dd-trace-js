'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')

// Channels that surface tracer-storage events to interested consumers
// (currently the wall profiler and the OTEP-4947 thread context writer).
//
// dd-trace:storage:enter — fires when the active legacy-storage store
//   changes. Published by the shimmer installed in ensureChannelsActivated().
// dd-trace:storage:before — fires from an async_hooks "before" callback in
//   non-AsyncContextFrame mode. Used by the wall profiler to refresh the
//   sample context at the start of each async resource callback. Has no
//   publisher in ACF mode.
// dd-trace:span:finish, dd-trace:span:tags:update — published by the
//   tracer core (opentracing/span.js). Re-exported here as a convenience
//   so consumers have a single import path for storage-related channels.
const enterCh = dc.channel('dd-trace:storage:enter')
const beforeCh = dc.channel('dd-trace:storage:before')
const spanFinishCh = dc.channel('dd-trace:span:finish')
const tagsUpdateCh = dc.channel('dd-trace:span:tags:update')

function getActiveSpan () {
  const store = storage('legacy').getStore()
  return store && store.span
}

let channelsActivated = false
// Idempotent. The asyncContextFrameEnabled argument from the first caller
// wins; subsequent calls are no-ops regardless of their argument. In
// practice all callers observe the same global ACF state.
function ensureChannelsActivated (asyncContextFrameEnabled) {
  if (channelsActivated) return

  const shimmer = require('../../datadog-shimmer')

  // We need to instrument enterWith() on the legacy storage — that's the storage
  // carrying span data and the only one consumers of these channels care about.
  const legacyStorage = storage('legacy')
  let inRun = false
  shimmer.wrap(legacyStorage, 'enterWith', function (original) {
    return function (store) {
      const retVal = original.call(this, store)
      if (!inRun) enterCh.publish()
      return retVal
    }
  })

  // When not using AsyncContextFrame, we need additional instrumentation.
  if (!asyncContextFrameEnabled) {
    // We need async_hooks.createHook to create a "before" callback.
    const { createHook } = require('async_hooks')
    createHook({ before: () => beforeCh.publish() }).enable()

    // In ACF-based implementation run() delegates to enterWith() so it doesn't
    // need to be separately instrumented. in non-ACF implementation run()
    // doesn't delegate to enterWith(), so separate instrumentation is necessary.
    shimmer.wrap(legacyStorage, 'run', function (original) {
      return function (store, callback, ...args) {
        const wrappedCb = shimmer.wrapFunction(callback, cb => function (...args) {
          inRun = false
          enterCh.publish()
          const retVal = cb.apply(this, args)
          inRun = true
          return retVal
        })
        inRun = true
        const retVal = original.call(this, store, wrappedCb, ...args)
        enterCh.publish()
        inRun = false
        return retVal
      }
    })
  }

  channelsActivated = true
}

module.exports = {
  enterCh,
  beforeCh,
  spanFinishCh,
  tagsUpdateCh,
  getActiveSpan,
  ensureChannelsActivated,
}
