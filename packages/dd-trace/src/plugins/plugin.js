'use strict'

const dc = require('diagnostics_channel')
const { storage } = require('../../../datadog-core')
const { TracingChannel } = require('../../../datadog-instrumentations/src/helpers/instrument')

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

class TracingSubscription {
  constructor (name, plugin, events = ['start', 'end', 'asyncEnd', 'error']) {
    this._channel = new TracingChannel(name)
    this._handlers = {}
    for (const name of events) {
      if (plugin[name]) {
        let fn
        if (name === 'start') {
          fn = (obj) => {
            const store = storage.getStore()
            if (store && store.noop) return
            const span = plugin.start(obj, store)
            if (!span) {
              throw new TypeError('plugin.start() must return a span')
            }
            plugin.enter(span, store)
          }
        } else if (name == 'end') {
          fn = (obj) => {
            const store = storage.getStore()
            if (store && store.noop) return
            plugin.end(obj, store)
            plugin.exit()
          }
        } else {
          fn = (obj) => {
            const store = storage.getStore()
            if (store && store.noop) return
            plugin[name](obj, store)
          }
        }

        this._handlers[name] = fn
      }
    }
  }

  enable () {
    this._channel.subscribe(this._handlers)
  }

  disable () {
    this._channel.unsubscribe(this._handlers)
  }
}

module.exports = class Plugin {
  constructor (tracer) {
    this._subscriptions = []
    this._enabled = false
    this._tracer = tracer

    if (this.prefix) {
      this._subscriptions.push(new TracingSubscription(this.prefix, this, this.events))
    }
  }

  get tracer () {
    return this._tracer._tracer
  }

  enter (span, store) {
    store = store || storage.getStore()
    storage.enterWith({ ...store, span, parent: store })
  }

  exit () {
    storage.enterWith(storage.getStore().parent)
  }

  /** Prevents creation of spans here and for all async descendants. */
  skip () {
    // TODO make this work with the parent chain
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
