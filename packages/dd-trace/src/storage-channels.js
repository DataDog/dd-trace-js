'use strict'

const dc = require('dc-polyfill')
const { storage } = require('../../datadog-core')
const { isACFActive } = require('../../datadog-core/src/storage')

// Channels that surface tracer-storage events to interested consumers
// (currently the wall profiler and the OTEP-4947 thread context writer).
//
// dd-trace:storage:enter — fires when the active legacy-storage store
//   changes. Published by the shimmer installed in acquireChannels().
// dd-trace:storage:before — fires from an async_hooks "before" callback while
//   at least one consumer that acquired the channels needs it. Used by the
//   wall profiler in its non-AsyncContextFrame (single holder) mode to refresh
//   the sample context at the start of each async resource callback.
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

// The legacy storage instrumentation feeding enterCh and beforeCh is installed
// lazily via acquireChannels() / releaseChannels(), ref-counted across
// consumers, so that once the last consumer stops (e.g. the profiler is turned
// off remotely), instrumentation is undone.
// Consumers MUST balance every acquireChannels() call with a matching
// releaseChannels() when they no longer use them.
let refCount = 0
// The async hook has a separate count: it's only needed by some consumers, and
// is a per-callback cost, so it's disabled as soon as the last of them releases.
let beforeRefCount = 0
let inRun = false
let beforeHook

// Wrappers currently installed on legacy storage, keyed by method name. Each
// entry records the method's own property descriptor from before wrapping
// (undefined when the method was inherited from the prototype) so it can be
// restored exactly.
const installedWrappers = new Map()

function wrapEnterWith (original) {
  return function (store) {
    const retVal = original.call(this, store)
    if (!inRun && refCount !== 0) enterCh.publish()
    return retVal
  }
}

function wrapRun (original) {
  const shimmer = require('../../datadog-shimmer')
  return function (store, callback, ...args) {
    if (refCount === 0) return original.call(this, store, callback, ...args)
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
}

function installWrapper (target, name, wrapper) {
  if (installedWrappers.has(name)) return
  const descriptor = Object.getOwnPropertyDescriptor(target, name)
  require('../../datadog-shimmer').wrap(target, name, wrapper)
  installedWrappers.set(name, { descriptor, wrapped: target[name] })
}

function uninstallWrappers (target) {
  for (const [name, { descriptor, wrapped }] of installedWrappers) {
    // If someone else wrapped the method on top of ours, restoring would
    // silently drop their wrapper too. Leave ours in place instead; it
    // short-circuits while released, and gets reused on the next acquisition.
    if (target[name] !== wrapped) continue
    if (descriptor === undefined) {
      delete target[name]
    } else {
      Object.defineProperty(target, name, descriptor)
    }
    installedWrappers.delete(name)
  }
}

/**
 * Acquires a reference to the channel publishers. The first reference installs
 * the legacy storage instrumentation publishing on enterCh.
 *
 * @param {boolean} needsBeforeHook Whether the consumer needs beforeCh events.
 *   The same value must be passed to the matching releaseChannels() call.
 */
function acquireChannels (needsBeforeHook) {
  if (refCount++ === 0) {
    // We need to instrument enterWith() on the legacy storage — that's the storage
    // carrying span data and the only one consumers of these channels care about.
    const legacyStorage = storage('legacy')
    installWrapper(legacyStorage, 'enterWith', wrapEnterWith)
    // In ACF-based implementation run() delegates to enterWith() so it doesn't
    // need to be separately instrumented. In non-ACF implementation run()
    // doesn't delegate to enterWith(), so separate instrumentation is necessary.
    if (!isACFActive) {
      installWrapper(legacyStorage, 'run', wrapRun)
    }
  }

  if (needsBeforeHook && beforeRefCount++ === 0) {
    beforeHook ??= require('async_hooks').createHook({ before: () => beforeCh.publish() })
    beforeHook.enable()
  }
}

/**
 * Releases one acquireChannels() reference. The async hook is disabled when the
 * last reference needing it is released, and the legacy storage instrumentation
 * is removed when the last reference overall is released.
 *
 * @param {boolean} needsBeforeHook The value passed to the matching
 *   acquireChannels() call.
 */
function releaseChannels (needsBeforeHook) {
  if (refCount === 0) return

  if (needsBeforeHook && beforeRefCount !== 0 && --beforeRefCount === 0) {
    beforeHook.disable()
  }

  if (--refCount === 0) {
    uninstallWrappers(storage('legacy'))
  }
}

module.exports = {
  enterCh,
  beforeCh,
  spanFinishCh,
  tagsUpdateCh,
  getActiveSpan,
  acquireChannels,
  releaseChannels,
}
