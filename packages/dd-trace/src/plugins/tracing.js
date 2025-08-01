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
    const store = storage('legacy').getStore()

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

  finish (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    span?.finish()
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
    if (span && !span._spanContext._tags.error) {
      // Errors may be wrapped in a context.
      error = (error && error.error) || error
      span.setTag('error', error || 1)
    }
  }

  startSpan (name, options = {}, enterOrCtx = true) {
    // TODO: modularize this code to a helper function
    let {
      component = this.component,
      childOf,
      integrationName,
      kind,
      meta,
      metrics,
      service,
      startTime,
      resource,
      type
    } = options

    const tracer = options.tracer || this.tracer
    const config = options.config || this.config

    const store = storage('legacy').getStore()
    if (store && childOf === undefined) {
      childOf = store.span
    }

    const span = tracer.startSpan(name, {
      startTime,
      childOf,
      tags: {
        [COMPONENT]: component,
        'service.name': service || meta?.service || tracer._service,
        'resource.name': resource,
        'span.kind': kind,
        'span.type': type,
        ...meta,
        ...metrics
      },
      integrationName: integrationName || component,
      links: childOf?._links
    })

    analyticsSampler.sample(span, config.measured)

    // TODO: Remove this after migration to TracingChannel is done.
    if (enterOrCtx === true) {
      storage('legacy').enterWith({ ...store, span })
    } else if (enterOrCtx) {
      enterOrCtx.parentStore = store
      enterOrCtx.currentStore = { ...store, span }
    }

    return span
  }
}

module.exports = TracingPlugin
