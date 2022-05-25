'use strict'

const dc = require('diagnostics_channel')
const { storage } = require('../../../datadog-core')

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
  constructor (tracer) {
    this._subscriptions = []
    this._enabled = false
    this._tracer = tracer
  }

  get tracer () {
    return this._tracer._tracer
  }

  enter (span, store) {
    store = store || storage.getStore()
    storage.enterWith({ ...store, span })
  }

  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    const store = storage.getStore()
    this._storeStack.push(store)
    storage.enterWith({ noop: true })
  }

  exit () {
    throw new Error('should not get here') // TODO: remove this when all done
  }

  addSub (channelName, handler) {
    this._subscriptions.push(new Subscription(channelName, handler))
  }

  addError (error) {
    const store = storage.getStore()

    if (!store || !store.span) return

    store.span.setTag('error', error)
  }

  configure (config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }
    this.config = config
    if (config.enabled && !this._enabled) {
      this._enabled = true
      this._subscriptions.forEach(sub => sub.enable())
    } else if (!config.enabled && this._enabled) {
      this._enabled = false
      this._subscriptions.forEach(sub => sub.disable())
    }
  }
}
