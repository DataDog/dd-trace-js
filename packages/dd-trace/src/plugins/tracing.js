'use strict'

const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')

class TracingPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.component = this.constructor.component || this.constructor.name
    this.operation = this.constructor.operation

    this.addTraceSub('start', message => {
      if (message && typeof message === 'object') {
       this.constructor.storesByContext.set(message, storage.getStore())
      }
      this.start(message)
    })

    this.addTraceSub('error', err => {
      this.error(err)
    })

    this.addTraceSub('finish', message => {
      this.finish(message)
    })

    this.addTraceSub('async_end', message => {
      this.asyncEnd(message)
    })

    this.addTraceSub('end', message => {
      this.end(message)
    })
  }

  get activeSpan () {
    const store = storage.getStore()

    return store && store.span
  }

  configure (config) {
    return super.configure({
      ...config,
      hooks: {
        [this.operation]: () => {},
        ...config.hooks
      }
    })
  }

  start () {} // implemented by individual plugins

  finish () {
    this.activeSpan.finish()
  }

  asyncEnd (...args) {
    this.finish(...args)
    // any non-IncomingPlugin plugins need to call exit here.
  }

  end (...args) {
    this.exit(...args)
  }

  error (error) {
    if (error && typeof error === 'object' && error.error) {
      error = error.error
    }
    this.addError(error)
  }

  addTraceSub (eventName, handler) {
    this.addSub(`apm:${this.component}:${this.operation}:${eventName}`, handler)
  }

  addError (error) {
    const span = this.activeSpan

    if (!span._spanContext._tags['error']) {
      span.setTag('error', error || 1)
    }
  }

  startSpan (name, { childOf, kind, meta, metrics, service, resource, type } = {}) {
    const store = storage.getStore()

    if (store && childOf === undefined) {
      childOf = store.span
    }

    const span = this.tracer.startSpan(name, {
      childOf,
      tags: {
        'service.name': service || this.tracer._service,
        'resource.name': resource,
        'span.kind': kind,
        'span.type': type,
        ...meta,
        ...metrics
      }
    })

    analyticsSampler.sample(span, this.config.measured)

    this.enter(span, store)

    return span
  }
}

module.exports = TracingPlugin
