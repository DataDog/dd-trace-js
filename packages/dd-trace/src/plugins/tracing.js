'use strict'

const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')
const { COMPONENT, SVC_SRC_KEY } = require('../constants')
const { markUserVisible } = require('../user_visibility')
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
   * @returns {{ name: string, source: string | undefined }}
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
      hooks: wrapHooksAsUserVisible({
        [this.operation]: () => {},
        ...config.hooks,
      }),
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
   * @param {string | { name: string, source?: string }} [options.service] - The service name, or an object with
   *   name and source.
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
    let serviceSource
    const tracer = options.tracer || this.tracer
    const config = options.config || this.config

    if (service && typeof service === 'object') {
      serviceSource = service.source
      service = service.name
    } else if (service !== undefined) {
      // service is a plain value returned by service naming/config logic
      serviceSource = service ? 'opt.plugin' : undefined
    }

    const store = storage('legacy').getStore()
    if (store && childOf === undefined) {
      childOf = /** @type {import('../opentracing/span') | undefined} */ (store.span)
    }

    // clear service source if service is the same as tracer._service
    const serviceName = service || meta?.service

    if (!serviceName || serviceName === tracer._service) {
      serviceSource = undefined
    }

    const span = tracer.startSpan(name, {
      startTime,
      childOf,
      tags: {
        [COMPONENT]: component,
        'service.name': serviceName || tracer._service,
        'resource.name': resource,
        'span.kind': kind,
        'span.type': type,
        ...(serviceSource === undefined ? undefined : { [SVC_SRC_KEY]: serviceSource }),
        ...meta,
        ...metrics,
      },
      integrationName: integrationName || component,
      links: childOf?._links,
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

/**
 * Wrap each user-supplied hook so that the span argument is marked as
 * user-visible before reaching user code. The hook can mutate the span via
 * the public API (setTag, addTags, etc.)
 *
 * @param {Record<string, Function>} hooks
 * @returns {Record<string, Function>}
 */
function wrapHooksAsUserVisible (hooks) {
  const wrapped = {}
  for (const name of Object.keys(hooks)) {
    const hook = hooks[name]
    if (typeof hook !== 'function') {
      wrapped[name] = hook
      continue
    }
    wrapped[name] = function (span, ...rest) {
      return hook.call(this, markUserVisible(span), ...rest)
    }
  }
  return wrapped
}

module.exports = TracingPlugin
