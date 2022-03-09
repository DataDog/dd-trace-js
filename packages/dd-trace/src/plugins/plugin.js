'use strict'

const dc = require('diagnostics_channel')
const { storage } = require('../../../datadog-core')
const { tracer } = require('../../../datadog-tracer')

class Subscription {
  constructor (event, handler) {
    this._channel = dc.channel(event)
    this._handler = (message, name) => {
      const store = storage.getStore()

      if (!store || !store.noop) {
        handler(message, name)
      }
    }
  }

  enable () {
    this._channel.subscribe(this._handler)
  }

  disable () {
    this._channel.unsubscribe(this._handler)
  }
}

module.exports = class Plugin {
  constructor () {
    this._subscriptions = []
    this._enabled = false
    this._storeStack = []
  }

  startSpan (name, options) {
    const store = storage.getStore()

    if (options.childOf === undefined) {
      options.childOf = store.span
    }

    const span = tracer.startSpan(name, options)

    this._storeStack.push(store)

    storage.enterWith({ ...store, span })

    return span
  }

  finishSpan () {
    const span = storage.getStore().span

    this._measure(span)

    span.finish()
  }

  addError (error) {
    storage.getStore().span.addError(error)
  }

  enter (span, store) {
    store = store || storage.getStore()
    this._storeStack.push(store)
    storage.enterWith({ ...store, span })
  }

  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    const store = storage.getStore()
    this._storeStack.push(store)
    storage.enterWith({ noop: true })
  }

  exit () {
    storage.enterWith(this._storeStack.pop())
  }

  addSub (channelName, handler) {
    this._subscriptions.push(new Subscription(channelName, handler))
  }

  configure (config) {
    this.config = config
    if (config.enabled && !this._enabled) {
      this._enabled = true
      this._subscriptions.forEach(sub => sub.enable())
    } else if (!config.enabled && this._enabled) {
      this._enabled = false
      this._subscriptions.forEach(sub => sub.disable())
    }
  }

  // TODO: replace with unified sampler
  _measure (span) {
    const measured = typeof this.config.measured === 'object'
      ? this.config.measured[span.name]
      : this.config.measured

    if (measured !== undefined) {
      span.measured = measured
    }
  }
}
