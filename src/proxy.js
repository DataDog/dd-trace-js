'use strict'

const BaseTracer = require('opentracing').Tracer
const NoopTracer = require('./noop/tracer')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const Instrumenter = require('./instrumenter')
const platform = require('./platform')
const log = require('./log')

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
    this._deprecate = method => log.deprecate(`tracer.${method}`, [
      `tracer.${method}() is deprecated.`,
      'Please use tracer.startSpan() and tracer.scope() instead.',
      'See: https://datadog.github.io/dd-trace-js/#manual-instrumentation.'
    ].join(' '))
  }

  /**
   * Initializes the tracer. This should be called before importing other libraries.
   *
   * @param {Object} [options] Configuration options.
   * @param {boolean} [options.enabled=true] Whether to enable the tracer.
   * @param {boolean} [options.debug=false] Enable debug logging in the tracer.
   * @param {string} [options.service] The service name to be used for this program.
   * @param {string} [options.url=null] The url to the trace agent that the tracer will submit to. Takes
   * precedence over hostname and port, if set.
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
      try {
        const service = platform.service()
        const config = new Config(service, options)

        if (config.enabled) {
          platform.validate()
          platform.configure(config)

          this._tracer = new DatadogTracer(config)
          this._instrumenter.enable()
          this._instrumenter.patch(config)
        }
      } catch (e) {
        log.error(e)
      }
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

  trace (operationName, options, callback) {
    this._deprecate('trace')

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

  scopeManager () {
    this._deprecate('scopeManager')
    return this._tracer.scopeManager.apply(this._tracer, arguments)
  }

  /**
   * Get the scope manager to manager context propagation for the tracer.
   *
   * @returns {Scope} The scope manager.
   */
  scope () {
    return this._tracer.scope.apply(this._tracer, arguments)
  }

  currentSpan () {
    this._deprecate('currentSpan')
    return this._tracer.currentSpan.apply(this._tracer, arguments)
  }

  bind (callback) {
    this._deprecate('bind')
    return callback
  }

  bindEmitter () {
    this._deprecate('bindEmitter')
  }
}

module.exports = Tracer
