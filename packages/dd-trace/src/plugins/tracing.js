'use strict'

const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')
const { COMPONENT } = require('../constants')
const { activateSpan } = require('../span_activation')
const Plugin = require('./plugin')

class TracingPlugin extends Plugin {
  constructor (...args) {
    super(...args)

    this.component = this.constructor.component || this.constructor.id
    this.operation = this.constructor.operation

    this.addTraceSubs()
  }

  get activeSpan () {
    const store = /** @type {{ span?: import('../../../..').Span }} */ (storage('legacy').getStore())

    return store?.span
  }

  /**
   * @param {object} opts
   * @param {string} [opts.type]
   * @param {string} [opts.id]
   * @param {string} [opts.kind]
   * @returns {string}
   */
  serviceName (opts = {}) {
    const {
      type = this.constructor.type,
      id = this.constructor.id,
      kind = this.constructor.kind,
    } = opts

    return this._tracer._nomenclature.serviceName(type, kind, id, opts)
  }

  /**
   * @param {object} opts
   * @param {string} [opts.type]
   * @param {string} [opts.id]
   * @param {string} [opts.kind]
   * @returns {string}
   */
  operationName (opts = {}) {
    const {
      type = this.constructor.type,
      id = this.constructor.id,
      kind = this.constructor.kind,
    } = opts

    return this._tracer._nomenclature.opName(type, kind, id, opts)
  }

  /**
   * @param {object} config
   * @returns {object}
   */
  configure (config) {
    return super.configure({
      ...config,
      hooks: {
        [this.operation]: () => {},
        ...config.hooks,
      },
    })
  }

  start () {} // implemented by individual plugins

  /**
   * @param {{ currentStore?: { span: import('../../../..').Span } }} ctx
   */
  finish (ctx) {
    const span = ctx?.currentStore?.span || this.activeSpan
    span?.finish()
  }

  /**
   * @param {{ currentStore?: { span: import('../../../..').Span }, error?: unknown }} ctxOrError
   */
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

  /**
   * @param {string} eventName
   * @param {Function} handler
   */
  addTraceSub (eventName, handler) {
    const prefix = this.constructor.prefix || `apm:${this.component}:${this.operation}`
    this.addSub(`${prefix}:${eventName}`, handler)
  }

  /**
   * @param {string} eventName
   * @param {Function} transform
   */
  addTraceBind (eventName, transform) {
    const prefix = this.constructor.prefix || `apm:${this.component}:${this.operation}`
    this.addBind(`${prefix}:${eventName}`, transform)
  }

  /**
   * @param {unknown} error
   * @param {import('../../../..').Span} [span]
   */
  addError (error, span = this.activeSpan) {
    if (span && !span._spanContext._tags.error) {
      // Errors may be wrapped in a context.
      span.setTag('error', error?.error || error || 1)
    }
  }

  /**
   * Start a new span.
   *
   * Important: `childOf` can be `null` to indicate that the span is a root span.
   * This is useful for plugins that need to start a span without a parent, such
   * as the root span of a serverless function.
   *
   * @example
   * const span = this.startSpan('my.span', {
   *   childOf: null,
   * })
   *
   * @param {string} name - The name of the span.
   * @param {object} [options] - The options for the span.
   * @param {string} [options.component] - The component of the span.
   * @param {import('../opentracing/span') | null} [options.childOf] - The parent span.
   * @param {string} [options.integrationName] - The integration name.
   * @param {string} [options.kind] - The kind of the span.
   * @param {object} [options.meta] - The meta data for the span.
   * @param {object} [options.metrics] - The metrics for the span.
   * @param {string} [options.service] - The service name.
   * @param {number} [options.startTime] - The start time of the span.
   * @param {string} [options.resource] - The resource name.
   * @param {string} [options.type] - The type of the span.
   * @param {import('../tracer')} [options.tracer] - The tracer.
   * @param {object} [options.config] - The config for the span.
   *
   * @param {boolean} enterOrCtx - Whether to enter the span context into the storage.
   */
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
      type,
    } = options

    const tracer = options.tracer || this.tracer
    const config = options.config || this.config

    const store = storage('legacy').getStore()
    if (store && childOf === undefined) {
      childOf = /** @type {import('../opentracing/span') | undefined} */ (store.span)
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
        ...metrics,
      },
      integrationName: integrationName || component,
      links: childOf?._links,
    })

    analyticsSampler.sample(span, config.measured)

    // TODO: Remove this after migration to TracingChannel is done.
    if (enterOrCtx === true) {
      activateSpan(store, span)
    } else if (enterOrCtx) {
      enterOrCtx.parentStore = store
      enterOrCtx.currentStore = { ...store, span }
    }

    return span
  }
}

module.exports = TracingPlugin
