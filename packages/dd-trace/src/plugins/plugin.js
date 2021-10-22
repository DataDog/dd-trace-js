'use strict'

const dc = require('diagnostics_channel')

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

  constructor () {
    this.#subscriptions = []
    this.#enabled = false
  }

  addWrappedSubscriptions(prefix, name, hooks = {}) {
    hooks = Object.assign({
      // TODO more hooks will eventually be needed
      tags: () => ({}),
      asyncEnd: () => {}
    }, hooks)
    this.addSubscription(prefix + ':start', ({ context, args }) => {
      let tags = hooks.tags.call(this, { context, args })
      if (context.noTrace) return
      const childOf = tracer().scope().active()
      tags = Object.assign({
        'service.name': this.config.service || tracer()._service
      }, tags)
      if (this.constructor.kind) {
        tags['span.kind'] = this.constructor.kind
      }
      const span = tracer().startSpan(name, { childOf, tags })
      console.log(tracer().scope().__proto__)
      context.parent = tracer().scope()._activeResource()
      context.span = span
      // TODO this and the the _exit below need to be replaces with something like `enterWith`
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
