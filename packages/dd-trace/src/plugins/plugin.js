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
