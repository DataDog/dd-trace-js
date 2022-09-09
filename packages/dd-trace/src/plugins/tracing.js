'use strict'

const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')

class TracingPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    const prefix = this.constructor.prefix

    this.addSub(`${prefix}:start`, ctx => {
      this.start(ctx)
    })

    this.addSub(`${prefix}:error`, err => {
      this.error(err)
      this.addError(err)
    })

    this.addSub(`${prefix}:finish`, ctx => {
      this.finish(ctx)
      storage.getStore().span.finish()
    })
  }

  start () {} // implemented by individual plugins

  finish () {} // implemented by individual plugins

  error () {} // implemented by individual plugins

  addError (error) {
    const store = storage.getStore()

    if (!store || !store.span) return

    if (!store.span._spanContext._tags['error']) {
      store.span.setTag('error', error || 1)
    }
  }

  startSpan (name, { childOf, kind, meta, metrics, service, resource, type } = {}) {
    const store = storage.getStore()

    if (store && childOf === undefined) {
      childOf = store.span
    }

    const span = this.tracer.startSpan(name, {
      tags: {
        'service.name': service,
        'resource.name': resource,
        'span.kind': kind,
        'span.type': type,
        ...meta,
        ...metrics
      }
    })

    analyticsSampler.sample(span, this.config.measured)

    storage.enterWith({ ...store, span })

    return span
  }
}

module.exports = TracingPlugin
