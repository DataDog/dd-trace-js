'use strict'

const BaseTracer = require('opentracing').Tracer
const NoopTracer = require('./noop')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const Instrumenter = require('./instrumenter')
const platform = require('./platform')

const noop = new NoopTracer()

/**
 * The Datadog Tracer. An instance of this class is what is returned by the module.
 *
 * @extends external:"opentracing.Tracer"
 * @hideconstructor
 */
class Tracer extends BaseTracer {
  constructor () {
    super()
    this._tracer = noop
    this._instrumenter = new Instrumenter(this)
  }

  /**
   * Initializes the tracer. This should be called before importing other libraries.
   *
   * @param {Object} [options] Configuration options.
   * @param {boolean} [options.debug=false] Enable debug logging in the tracer.
   * @param {string} [options.service] The service name to be used for this program.
   * @param {string} [options.hostname=localhost] The address of the trace agent that the tracer will submit to.
   * @param {number|string} [options.port=8126] The port of the trace agent that the tracer will submit to.
   * @param {number} [options.sampleRate=1] Percentage of spans to sample as a float between 0 and 1.
   * @param {number} [options.flushInterval=2000] Interval in milliseconds at which the tracer
   * will submit traces to the agent.
   * @param {Object|boolean} [options.experimental={}] Experimental features can be enabled all at once
   * using boolean `true` or individually using key/value pairs.
   * @param {boolean} [options.plugins=true] Whether to load all built-in plugins.
   * @returns {Tracer} Self
   */
  init (options) {
    if (this._tracer === noop) {
      platform.load()

      const config = new Config(options)

      platform.configure(config)

      this._tracer = new DatadogTracer(config)
      this._instrumenter.patch(config)
    }

    return this
  }

  /**
   * Enable and optionally configure a plugin.
   *
   * @param {string} plugin The name of a built-in plugin.
   * @param {Object} [config] Configuration options.
   * @param {string} [config.service] The service name to be used for this plugin.
   * @returns {Tracer} Self
   */
  use () {
    this._instrumenter.use.apply(this._instrumenter, arguments)
    return this
  }

  /**
   * Initiate a trace and creates a new span.
   *
   * @param {string} name The operation name to be used for this span.
   * @param {Object} [options] Configuration options. These will take precedence over environment variables.
   * @param {string} [options.service] The service name to be used for this span.
   * The service name from the tracer will be used if this is not provided.
   * @param {string} [options.resource] The resource name to be used for this span.
   * The operation name will be used if this is not provided.
   * @param {string} [options.type] The span type to be used for this span.
   * @param {?external:"opentracing.Span"|external:"opentracing.SpanContext"} [options.childOf]
   * The parent span or span context for the new span. Generally this is not needed as it will be
   * fetched from the current context.
   * @param {string} [options.tags={}] Global tags that should be assigned to every span.
   * @param {traceCallback} [callback] Optional callback. A promise will be returned instead if not set.
   * @returns {Promise<external:"opentracing.Span">|undefined}
   */
  trace (operationName, options, callback) {
    if (callback) {
      return this._tracer.trace(operationName, options, callback)
    } else if (options instanceof Function) {
      return this._tracer.trace(operationName, options)
    } else if (options) {
      return new Promise((resolve, reject) => {
        this._tracer.trace(operationName, options, span => resolve(span))
      })
    } else {
      return new Promise((resolve, reject) => {
        this._tracer.trace(operationName, span => resolve(span))
      })
    }
  }

  startSpan () {
    return this._tracer.startSpan.apply(this._tracer, arguments)
  }

  inject () {
    return this._tracer.inject.apply(this._tracer, arguments)
  }

  extract () {
    return this._tracer.extract.apply(this._tracer, arguments)
  }

  /**
   * Get the span from the current context.
   *
   * @returns {?external:"opentracing.Span"} The current span or null if outside a trace context.
   */
  currentSpan () {
    return this._tracer.currentSpan.apply(this._tracer, arguments)
  }

  /**
   * Bind a function to the current trace context.
   *
   * @param {Function} callback The function to bind.
   * @returns {Function} The callback wrapped up in a context closure.
   */
  bind () {
    return this._tracer.bind.apply(this._tracer, arguments)
  }

  /**
   * Bind an EventEmitter to the current trace context.
   *
   * @param {Function} callback The function to bind.
   */
  bindEmitter () {
    this._tracer.bindEmitter.apply(this._tracer, arguments)
  }
}

module.exports = Tracer
