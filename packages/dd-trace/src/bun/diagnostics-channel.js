'use strict'

// Bun can garbage-collect channels that still have subscribers or bound stores.
// TODO: Remove once Bun fixes this.

const { isBun } = require('.')

if (isBun) {
  try {
    patchActiveChannel()
  } catch {
    // The workaround depends on Bun internals. An incompatible implementation must not prevent startup.
  }
}

function patchActiveChannel () {
  const dc = require('dc-polyfill')
  const patched = Symbol.for('dd-trace.bun-diagnostics-channel-gc')
  const probe = dc.channel(Symbol('dd-trace:bun-diagnostics-channel-probe'))

  // Bun swaps a channel to a separate prototype while it has subscribers or bound stores, and the inactive prototype
  // delegates its first subscribe() and bindStore() call to it. Patching only the active prototype covers both paths.
  const inactiveProto = Object.getPrototypeOf(probe)
  probe.subscribe(noop)
  const proto = Object.getPrototypeOf(probe)
  probe.unsubscribe(noop)

  if (!proto || proto === inactiveProto || Object.getPrototypeOf(probe) !== inactiveProto ||
      Object.hasOwn(proto, patched) || !Object.isExtensible(proto)) return

  // Check every method before wrapping any of them so an incompatible prototype is left untouched.
  for (const name of ['subscribe', 'unsubscribe', 'bindStore', 'unbindStore']) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name)
    if (!descriptor?.writable || typeof descriptor.value !== 'function') return
  }

  // The set is intentionally write-only: membership keeps the channels alive.
  // eslint-disable-next-line sonarjs/no-unused-collection
  const active = new Set()
  const { subscribe, unsubscribe, bindStore, unbindStore } = proto

  proto.subscribe = function (subscription) {
    const result = subscribe.call(this, subscription)
    active.add(this)
    return result
  }

  proto.bindStore = function (store, transform) {
    const result = bindStore.call(this, store, transform)
    active.add(this)
    return result
  }

  proto.unsubscribe = function (subscription) {
    const result = unsubscribe.call(this, subscription)
    if (!this.hasSubscribers) active.delete(this)
    return result
  }

  proto.unbindStore = function (store) {
    const result = unbindStore.call(this, store)
    if (!this.hasSubscribers) active.delete(this)
    return result
  }

  Object.defineProperty(proto, patched, { value: true })
}

function noop () {}
