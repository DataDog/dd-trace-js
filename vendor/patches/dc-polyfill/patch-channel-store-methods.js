'use strict'

const { apply } = Reflect
const { defineProperty, getOwnPropertyDescriptor, getPrototypeOf } = Object

function wrapStoreRun (store, data, next, transform = defaultTransform) {
  return () => {
    let context

    try {
      context = transform(data)
    } catch (error) {
      process.nextTick(() => { throw error })
      return next()
    }

    return store.run(context, next)
  }
}

function defaultTransform (data) {
  return data
}

// dc-polyfill normally assigns a new store Map whenever a physical copy first
// sees a channel. Keep a non-empty Map so a user copy loaded after the vendored
// copy cannot discard dd-trace's bindings. Node must still be able to clear an
// empty Map when a channel becomes inactive.
module.exports = function patchChannelStoreMethods (dc) {
  const seen = new WeakSet()
  const originalChannel = dc.channel
  const patched = { ...dc }

  patched.channel = function () {
    const channel = originalChannel.apply(this, arguments)
    if (seen.has(channel)) return channel

    const descriptor = getOwnPropertyDescriptor(channel, '_stores')
    let stores = descriptor?.value
    defineProperty(channel, '_stores', {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get () {
        return stores
      },
      set (value) {
        if (!stores || stores.size === 0) stores = value
      },
    })
    channel._stores ??= new Map()
    channel.bindStore = function (store, transform) {
      this._stores ??= new Map()
      this._stores.set(store, transform)
    }
    channel.unbindStore = function (store) {
      if (!this._stores?.has(store)) return false
      this._stores.delete(store)
      return true
    }
    channel.runStores = function (data, fn, thisArg, ...args) {
      let run = () => {
        this.publish(data)
        return apply(fn, thisArg, args)
      }

      for (const [store, transform] of this._stores?.entries() ?? []) {
        run = wrapStoreRun(store, data, run, transform)
      }

      return run()
    }

    if (!getOwnPropertyDescriptor(channel, 'hasSubscribers')) {
      defineProperty(channel, 'hasSubscribers', {
        get () {
          return getPrototypeOf(this).hasSubscribers || (this._stores?.size ?? 0) > 0
        },
      })
    }

    seen.add(channel)
    return channel
  }

  return patched
}
