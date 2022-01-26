'use strict'

const BaseTracer = require('opentracing').Tracer
const NoopTracer = require('./noop/tracer')
const DatadogTracer = require('./tracer')
const Config = require('./config')
const Instrumenter = require('./instrumenter')
const PluginManager = require('./plugin_manager')
const metrics = require('./metrics')
const log = require('./log')
const { isFalse } = require('./util')
const { setStartupLogInstrumenter } = require('./startup-log')

const noop = new NoopTracer()

class Tracer extends BaseTracer {
  constructor () {
    super()

    this._initialized = false
    this._tracer = noop
    this._instrumenter = new Instrumenter(this)
    this._pluginManager = new PluginManager(this)
    this._deprecate = method => log.deprecate(`tracer.${method}`, [
      `tracer.${method}() is deprecated.`,
      'Please use tracer.startSpan() and tracer.scope() instead.',
      'See: https://datadog.github.io/dd-trace-js/#manual-instrumentation.'
    ].join(' '))
  }

  init (options) {
    if (isFalse(process.env.DD_TRACE_ENABLED) || this._initialized) return this

    this._initialized = true

    try {
      const config = new Config(options) // TODO: support dynamic config

      log.use(config.logger)
      log.toggle(config.debug, config.logLevel, this)

      if (config.profiling.enabled) {
        // do not stop tracer initialization if the profiler fails to be imported
        try {
          const profiler = require('./profiler')
          profiler.start(config)
        } catch (e) {
          log.error(e)
        }
      }

      if (config.runtimeMetrics) {
        metrics.start(config)
      }

      if (config.tracing) {
        // dirty require for now so zero appsec code is executed unless explicitly enabled
        if (config.appsec.enabled) {
          require('./appsec').enable(config)
        }

        this._tracer = new DatadogTracer(config)
        this._instrumenter.enable(config)
        this._pluginManager.configure(config)
        setStartupLogInstrumenter(this._instrumenter)
      }
    } catch (e) {
      log.error(e)
    }

    return this
  }

  use () {
    this._instrumenter.use(...arguments)
    this._pluginManager.configurePlugin(...arguments)
    return this
  }

  trace (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return

    options = options || {}

    return this._tracer.trace(name, options, fn)
  }

  wrap (name, options, fn) {
    if (!fn) {
      fn = options
      options = {}
    }

    if (typeof fn !== 'function') return fn

    options = options || {}

    return this._tracer.wrap(name, options, fn)
  }

  setUrl () {
    this._tracer.setUrl.apply(this._tracer, arguments)
    return this
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

  getRumData () {
    return this._tracer.getRumData.apply(this._tracer, arguments)
  }
}

module.exports = Tracer
