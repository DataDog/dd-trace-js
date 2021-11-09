'use strict'

const dc = require('diagnostics_channel')
const { storage } = require('../../../datadog-core')

class Subscription {
  #channel
  #handler

  constructor (event, handler) {
    this.#channel = dc.channel(event)
    this.#handler = handler
  }

  enable () {
    this.#channel.subscribe(this.#handler)
  }

  disable () {
    this.#channel.unsubscribe(this.#handler)
  }
}

module.exports = class Plugin {
  #subscriptions
  #enabled
  #storeStack

  constructor () {
    this.#subscriptions = []
    this.#enabled = false
    this.#storeStack = []
  }

  startSpanAndEnter (name, customTags) {
    const tags = {
      // TODO this needs to be sometimes suffixed
      'service.name': this.config.service || tracer()._service
    }
    if (this.kind) {
      tags['span.kind'] = this.kind
    }
    for (const tag in customTags) {
      tags[tag] = customTags[tag]
    }
    const store = storage.getStore()
    const childOf = store ? store.span : null
    const span = tracer().startSpan(name, {
      childOf,
      tags
    })
    this.enter(span, store)
    return span
  }

  enter (span, store) {
    store ||= storage.getStore()
    this.#storeStack.push(store)
    storage.enterWith({ ...store, span })
  }

  exit () {
    storage.enterWith(this.#storeStack.pop())
  }

  addSub (channelName, handler) {
    this.#subscriptions.push(new Subscription(channelName, handler))
  }

  configure (config) {
    this.config = config
    if (config.enabled && !this.#enabled) {
      this.#enabled = true
      this.#subscriptions.forEach(sub => sub.enable())
    } else if (!config.enabled && this.#enabled) {
      this.#enabled = false
      this.#subscriptions.forEach(sub => sub.disable())
    }
  }
}

function tracer () {
  return global._ddtrace._tracer
}
