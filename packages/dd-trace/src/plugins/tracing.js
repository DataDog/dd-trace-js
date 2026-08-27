'use strict'

const { storage } = require('../../../datadog-core')
const analyticsSampler = require('../analytics_sampler')
const { COMPONENT, SVC_SRC_KEY } = require('../constants')
const { INTEGRATION_SERVICE } = require('../service-naming/source-resolver')
const Plugin = require('./plugin')

const legacyStorage = storage('legacy')

/**
 * @typedef {object} NamingPluginConfig
 * @property {string | ((params?: object) => string | undefined)} [service]
 * @property {boolean} [splitByDomain]
 * @property {boolean} [splitByInstance]
 */

/**
 * @typedef {object} NamingOptions
 * @property {string} [awsService]
 * @property {string} [connectionName]
 * @property {object} [dbConfig]
 * @property {string} [operation]
 * @property {object} [params]
 * @property {NamingPluginConfig} [pluginConfig]
 * @property {string | { host?: string, port?: string | number }} [sessionDetails]
 * @property {string} [system]
 */

/**
 * @typedef {object} NamingDefinition
 * @property {(options: NamingOptions) => string} operationName
 * @property {(tracerService: string, options: NamingOptions) => string | undefined} serviceName
 * @property {(tracerService: string, options: NamingOptions) => string | undefined} serviceSource
 */

/**
 * @typedef {object} NamingSchema
 * @property {NamingDefinition} v0
 * @property {NamingDefinition} v1
 */

/** @returns {never} */
function missingOperationName () {
  throw new Error('The plugin must implement getNamingSchema() before it uses operationName()')
}

/** @returns {never} */
function missingServiceName () {
  throw new Error('The plugin must implement getNamingSchema() before it uses serviceName()')
}

class TracingPlugin extends Plugin {
  /** @type {NamingDefinition['operationName']} */
  #operationName = missingOperationName
  /** @type {NamingDefinition['serviceName']} */
  #serviceName = missingServiceName
  /** @type {NamingDefinition['serviceSource']} */
  #serviceSource = missingServiceName
  #tracerService = ''

  constructor (...args) {
    super(...args)

    this.component = this.constructor.component || this.constructor.id
    this.operation = this.constructor.operation

    this.addTraceSubs()
  }

  get activeSpan () {
    const store = /** @type {{ span?: import('../../../..').Span }} */ (legacyStorage.getStore())

    return store?.span
  }

  /**
   * @abstract
   * @returns {NamingSchema}
   */
  getNamingSchema () {
    throw new Error(`${this.constructor.name} must implement getNamingSchema()`)
  }

  /**
   * @param {NamingOptions} opts
   * @returns {{ name: string, source: string | undefined }}
   */
  serviceName (opts = {}) {
    return {
      name: /** @type {string} */ (this.#serviceName(this.#tracerService, opts)),
      source: this.#serviceSource(this.#tracerService, opts),
    }
  }

  /**
   * @param {NamingOptions} opts
   * @returns {string}
   */
  operationName (opts = {}) {
    return this.#operationName(opts)
  }

  /**
   * @param {object} config
   * @returns {object}
   */
  configure (config) {
    if (this.getNamingSchema !== TracingPlugin.prototype.getNamingSchema) {
      const namingSchema = this.getNamingSchema()
      const { service, spanAttributeSchema, spanRemoveIntegrationFromService } = this._tracerConfig
      const operationDefinition = namingSchema[spanAttributeSchema]
      const serviceDefinition = spanAttributeSchema === 'v0' && spanRemoveIntegrationFromService
        ? namingSchema.v1
        : operationDefinition

      this.#operationName = operationDefinition.operationName
      this.#serviceName = serviceDefinition.serviceName
      this.#serviceSource = serviceDefinition.serviceSource
      this.#tracerService = service
    }

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
        this.addTraceSub(event, this[event].bind(this))
      }

      if (this[bindName]) {
        this.addTraceBind(event, this[bindName].bind(this))
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
   * Record the integration's intended `service.name` on a span without writing the tag.
   *
   * Use this when the plugin has already set `service.name` directly on the span (e.g. via
   * the `tracer.startSpan` tags object) and only needs to stamp the marker so
   * `Span#finish` can later detect user overrides and re-attribute the source.
   *
   * Prefer {@link TracingPlugin#setServiceName} when the tag itself also needs to be written.
   *
   * No-op when there is nothing meaningful to record
   *
   * @param {import('../opentracing/span')} span Internal DatadogSpan instance.
   * @param {string|undefined} name Service name the integration is claiming.
   */
  stampIntegrationService (span, name) {
    if (name === undefined) return
    span[INTEGRATION_SERVICE] = name
  }

  /**
   * Set `service.name` on a span on behalf of this integration and stamp the marker.
   *
   * Use this for late-binding cases where the service is not known at startSpan time
   * (e.g. web framework config applied after the span is already open).
   *
   * For spans started via {@link TracingPlugin#startSpan}, pass `service` as an option
   * instead — it sets the tag and stamps the marker in one step.
   *
   * @param {import('../opentracing/span')} span Internal DatadogSpan instance.
   * @param {string} name Service name the integration is claiming.
   */
  setServiceName (span, name) {
    // eslint-disable-next-line eslint-rules/eslint-prefer-set-service-name -- this is the implementation
    span._spanContext.setTag('service.name', name)
    this.stampIntegrationService(span, name)
  }

  /**
   * @param {unknown} error
   * @param {import('../../../..').Span} [span]
   */
  addError (error, span = this.activeSpan) {
    if (span && !span.context().getTag('error')) {
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

    const store = legacyStorage.getStore()
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

    this.stampIntegrationService(span, serviceName)

    analyticsSampler.sample(span, config.measured)

    // TODO: Remove this after migration to TracingChannel is done.
    // eslint-disable-next-line unicorn/no-unnecessary-boolean-comparison -- Context objects use the other branch.
    if (enterOrCtx === true) {
      legacyStorage.enterWith({ ...store, span })
    } else if (enterOrCtx) {
      enterOrCtx.parentStore = store
      enterOrCtx.currentStore = { ...store, span }
    }

    return span
  }
}

module.exports = TracingPlugin
