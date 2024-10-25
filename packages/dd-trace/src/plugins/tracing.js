'use strict'

const Plugin = require('./plugin')
const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')
const { COMPONENT } = require('../constants')

class TracingPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.component = this.constructor.component || this.constructor.id
    this.operation = this.constructor.operation

    this.addTraceSubs()
  }

  get activeSpan () {
    const store = storage.getStore()

    return store && store.span
  }

  serviceName (opts = {}) {
    const {
      type = this.constructor.type,
      id = this.constructor.id,
      kind = this.constructor.kind
    } = opts

    return this._tracer._nomenclature.serviceName(type, kind, id, opts)
  }

  operationName (opts = {}) {
    const {
      type = this.constructor.type,
      id = this.constructor.id,
      kind = this.constructor.kind
    } = opts

    return this._tracer._nomenclature.opName(type, kind, id, opts)
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
    this.activeSpan?.finish()
  }

  error (ctxOrError) {
    if (ctxOrError?.currentStore) {
      ctxOrError.currentStore?.span.setTag('error', ctxOrError?.error)
      return
    }
    this.addError(ctxOrError)
  }

  addTraceSubs () {
    const events = ['start', 'end', 'asyncStart', 'asyncEnd', 'error', 'finish']

    for (const event of events) {
      const bindName = `bind${event.charAt(0).toUpperCase()}${event.slice(1)}`

      if (this[event]) {
        this.addTraceSub(event, message => {
          this[event](message)
        })
      }

      if (this[bindName]) {
        this.addTraceBind(event, message => this[bindName](message))
      }
    }
  }

  addTraceSub (eventName, handler) {
    const prefix = this.constructor.prefix || `apm:${this.component}:${this.operation}`
    this.addSub(`${prefix}:${eventName}`, handler)
  }

  addTraceBind (eventName, transform) {
    const prefix = this.constructor.prefix || `apm:${this.component}:${this.operation}`
    this.addBind(`${prefix}:${eventName}`, transform)
  }

  addError (error, span = this.activeSpan) {
    if (!span._spanContext._tags.error) {
      // Errors may be wrapped in a context.
      error = (error && error.error) || error
      span.setTag('error', error || 1)
    }
  }

  startSpan (name, { childOf, kind, meta, metrics, service, resource, type } = {}, enter = true) {
    const store = storage.getStore()

    if (store && childOf === undefined) {
      childOf = store.span
    }

    const span = this.tracer.startSpan(name, {
      childOf,
      tags: {
        [COMPONENT]: this.component,
        'service.name': service || this.tracer._service,
        'resource.name': resource,
        'span.kind': kind,
        'span.type': type,
        ...meta,
        ...metrics
      },
      integrationName: type
    })

    analyticsSampler.sample(span, this.config.measured)

    // TODO: Remove this after migration to TracingChannel is done.
    if (enter) {
      storage.enterWith({ ...store, span })
    }

    return span
  }
}

module.exports = TracingPlugin
