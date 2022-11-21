'use strict'

const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')
const { COMPONENT } = require('../constants')

const defaultMeta = (metaActual) => {
  const meta = { ...metaActual }
  meta[COMPONENT] = metaActual.component || this.component
  return meta
}

class TracingPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.component = this.constructor.component || this.constructor.name
    this.operation = this.constructor.operation

    this.addTraceSub('start', message => {
      this.start(message)
    })

    this.addTraceSub('error', err => {
      this.error(err)
    })

    this.addTraceSub('finish', message => {
      this.finish(message)
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

  error (error) {
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

  startSpan (name, { childOf, kind, meta = (meta) => defaultMeta(meta), metrics, service, resource, type } = {}) {
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
        ...meta(),
        ...metrics
      }
    })

    analyticsSampler.sample(span, this.config.measured)

    storage.enterWith({ ...store, span })

    return span
  }
}

module.exports = TracingPlugin
