'use strict'

const {
  Channel,
  channel
} = require('diagnostics_channel') // eslint-disable-line n/no-restricted-require

const [major, minor] = process.versions.node.split('.')
const channels = new WeakSet()

// Our own DC with a limited subset of functionality stable across Node versions.
// TODO: Move the rest of the polyfill here.
// TODO: Switch to using global subscribe/unsubscribe/hasSubscribers.
const dc = { channel }

// Prevent going to 0 subscribers to avoid bug in Node.
// See https://github.com/nodejs/node/pull/47520
if (major === '19' && minor === '9') {
  dc.channel = function () {
    const ch = channel.apply(this, arguments)

    if (!channels.has(ch)) {
      const subscribe = ch.subscribe
      const unsubscribe = ch.unsubscribe

      ch.subscribe = function () {
        delete ch.subscribe
        delete ch.unsubscribe

        const result = subscribe.apply(this, arguments)

        this.subscribe(() => {}) // Keep it active forever.

        return result
      }

      if (ch.unsubscribe === Channel.prototype.unsubscribe) {
        // Needed because another subscriber could have subscribed to something
        // that we unsubscribe to before the library is loaded.
        ch.unsubscribe = function () {
          delete ch.subscribe
          delete ch.unsubscribe

          this.subscribe(() => {}) // Keep it active forever.

          return unsubscribe.apply(this, arguments)
        }
      }

      channels.add(ch)
    }

    return ch
  }
}

if (!Channel.prototype.runStores) {
  const ActiveChannelPrototype = getActiveChannelPrototype()

  Channel.prototype.bindStore = ActiveChannelPrototype.bindStore = function (store, transform) {
    if (!this._stores) {
      this._stores = new Map()
    }
    this._stores.set(store, transform)
  }

  Channel.prototype.unbindStore = ActiveChannelPrototype.unbindStore = function (store) {
    if (!this._stores) return
    this._stores.delete(store)
  }

  Channel.prototype.runStores = ActiveChannelPrototype.runStores = function (data, fn, thisArg, ...args) {
    if (!this._stores) return Reflect.apply(fn, thisArg, args)

    let run = () => {
      this.publish(data)
      return Reflect.apply(fn, thisArg, args)
    }

    for (const entry of this._stores.entries()) {
      const store = entry[0]
      const transform = entry[1]
      run = wrapStoreRun(store, data, run, transform)
    }

    return run()
  }
}

function defaultTransform (data) {
  return data
}

function wrapStoreRun (store, data, next, transform = defaultTransform) {
  return () => {
    let context
    try {
      context = transform(data)
    } catch (err) {
      process.nextTick(() => {
        throw err
      })
      return next()
    }

    return store.run(context, next)
  }
}

function getActiveChannelPrototype () {
  const dummyChannel = channel('foo')
  const listener = () => {}

  dummyChannel.subscribe(listener)
  const ActiveChannelPrototype = Object.getPrototypeOf(dummyChannel)
  dummyChannel.unsubscribe(listener)

  return ActiveChannelPrototype
}

module.exports = dc
