'use strict'

// TODO: move anything related to tracing to TracingPlugin instead

const dc = require('dc-polyfill')
const logger = require('../log')
const { storage } = require('../../../datadog-core')

class Subscription {
  constructor (event, handler) {
    this._channel = dc.channel(event)
    this._handler = (message, name) => {
      const store = storage('legacy').getStore()
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

class StoreBinding {
  constructor (event, transform) {
    this._channel = dc.channel(event)
    this._transform = data => {
      const store = storage('legacy').getStore()

      return !store || !store.noop
        ? transform(data)
        : store
    }
  }

  enable () {
    this._channel.bindStore(storage('legacy'), this._transform)
  }

  disable () {
    this._channel.unbindStore(storage('legacy'))
  }
}

module.exports = class Plugin {
  constructor (tracer, tracerConfig) {
    this._subscriptions = []
    this._bindings = []
    this._enabled = false
    this._tracer = tracer
    this.config = {} // plugin-specific configuration, unset until .configure() is called
    this._tracerConfig = tracerConfig // global tracer configuration
  }

  get tracer () {
    return this._tracer._tracer
  }

  enter (span, store) {
    store = store || storage('legacy').getStore()
    storage('legacy').enterWith({ ...store, span })
  }

  // TODO: Implement filters on resource name for all plugins.
  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    storage('legacy').enterWith({ noop: true })
  }

  addSub (channelName, handler) {
    const plugin = this
    const wrappedHandler = function () {
      try {
        return handler.apply(this, arguments)
      } catch (e) {
        logger.error('Error in plugin handler:', e)
        logger.info('Disabling plugin: %s', plugin.id)
        plugin.configure(false)
      }
    }
    this._subscriptions.push(new Subscription(channelName, wrappedHandler))
  }

  addBind (channelName, transform) {
    this._bindings.push(new StoreBinding(channelName, transform))
  }

  addError (error) {
    const store = storage('legacy').getStore()

    if (!store || !store.span) return

    if (!store.span._spanContext._tags.error) {
      store.span.setTag('error', error || 1)
    }
  }

  configure (config) {
    if (typeof config === 'boolean') {
      config = { enabled: config }
    }
    this.config = config
    if (config.enabled && !this._enabled) {
      this._enabled = true
      this._subscriptions.forEach(sub => sub.enable())
      this._bindings.forEach(sub => sub.enable())
    } else if (!config.enabled && this._enabled) {
      this._enabled = false
      this._subscriptions.forEach(sub => sub.disable())
      this._bindings.forEach(sub => sub.disable())
    }
  }
}
