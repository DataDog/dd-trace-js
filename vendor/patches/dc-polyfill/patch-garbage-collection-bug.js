'use strict'

const { defineProperty, getOwnPropertyDescriptor } = Object

const PHONY_SUBSCRIBE = function () {}

// Older Node.js versions retain channels by adding a no-op subscriber. When
// more than one dc-polyfill copy is loaded, every copy adds its own no-op and
// the upstream length check mistakes the extras for real subscribers.
function hasRealSubscribers (channel) {
  const subscribers = channel._subscribers
  if (subscribers?.some(subscriber => (
    subscriber.name !== 'AVOID_GARBAGE_COLLECTION' &&
    subscriber.name !== 'PHONY_SUBSCRIBE'
  ))) return true
  return channel._stores?.size > 0
}

module.exports = function patchGarbageCollectionBug (dc) {
  const originalChannel = dc.channel
  const seen = new WeakSet()
  const channels = new Map()
  const patched = { ...dc }

  patched.channel = function () {
    const name = arguments[0]
    if (channels.has(name)) return channels.get(name)

    const channel = originalChannel.apply(this, arguments)
    channels.set(name, channel)

    if (!seen.has(channel)) {
      // A user copy got here first and already installed the retention
      // subscriber and its corresponding getter. Adding another subscriber
      // would make that getter report a false positive.
      if (getOwnPropertyDescriptor(channel, 'hasSubscribers')) return channel

      originalChannel(name).subscribe(PHONY_SUBSCRIBE)
      seen.add(channel)

      defineProperty(channel, 'hasSubscribers', {
        configurable: true,
        get () {
          return hasRealSubscribers(channel)
        },
      })
    }

    return channel
  }

  return patched
}
