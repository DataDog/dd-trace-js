'use strict'

// TODO: move anything related to tracing to TracingPlugin instead

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
    this._storesByContext = new WeakMap()
  }

  get tracer () {
    return this._tracer._tracer
  }

  enter (span, store) {
    store = store || storage.getStore()
    storage.enterWith({ ...store, span })
  }

  exit (ctx) {
    storage.enterWith(this.getStoreByContext(ctx))
  }

  // TODO: Implement filters on resource name for all plugins.
  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    storage.enterWith({ noop: true })
  }

  addSub (channelName, handler) {
    this._subscriptions.push(new Subscription(channelName, handler))
  }

  addError (error) {
    const store = storage.getStore()

    if (!store || !store.span) return

    if (!store.span._spanContext._tags['error']) {
      store.span.setTag('error', error || 1)
    }
  }

  setStoreByContext (context, store) {
    this._storesByContext.set(context, store)
  }

  getStoreByContext (context) {
    return this._storesByContext.get(context)
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
