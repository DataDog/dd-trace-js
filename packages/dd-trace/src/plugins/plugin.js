'use strict'

const dc = require('diagnostics_channel')

class Subscription {
  #enabled
  #channel
  #handler

  constructor (event, handler) {
    this.#enabled = false
    this.#channel = dc.channel(event)
    this.#handler = handler
  }

  get isEnabled () {
    return this.#enabled
  }

  enable () {
    this.#channel.subscribe(this.#handler)
    this.#enabled = true
  }

  disable () {
    this.#channel.unsubscribe(this.#handler)
    this.#enabled = false
  }
}

module.exports = class Plugin {
  #subscriptions

  constructor (config) {
    this.#subscriptions = []
    this.config = config
  }

  addWrappedSubscriptions(prefix, name, hooks = {}) {
    hooks = Object.assign({
      tags: () => ({}),
      asyncEnd: () => {}
    }, hooks)
    this.addSubscription(prefix + ':start', ({ context, args }) => {
      const tags = hooks.tags.call(this, { context, args })
      if (context.noTrace) return
      const span = startSpan(this.config, name, tags)
      context.parent = tracer().scope()._activeResource()
      context.span = span
      tracer().scope()._enter(span, context.parent)
    })
    this.addSubscription(prefix + ':end', ({ context }) => {
      if (context.noTrace) return
      tracer().scope()._exit(context.parent)
    })
    this.addSubscription(prefix + ':async-end', ({ context, result }) => {
      if (context.noTrace) return
      hooks.asyncEnd.call(this, { context, result })
      context.span.finish()
    })
    this.addSubscription(prefix + ':error', ({ context, error }) => {
      if (context.noTrace) return
      context.span.addError(error)
      context.span.finish()
    })
  }

  addSubscription (channelName, handler) {
    this.#subscriptions.push(new Subscription(channelName, handler))
  }

  enable () {
    this.#subscriptions.forEach(sub => sub.enable())
  }

  disable () {
    this.#subscriptions.forEach(sub => sub.disable())
  }
}

function tracer () {
  return global._ddtrace._tracer
}
