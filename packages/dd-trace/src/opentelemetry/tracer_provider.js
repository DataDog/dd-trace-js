'use strict'

const { W3CTraceContextPropagator } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')
const { getApi } = require('./api')

const ContextManager = require('./context_manager')
const { MultiSpanProcessor, NoopSpanProcessor } = require('./span_processor')
const Tracer = require('./tracer')

class TracerProvider {
  #activeProcessor = new NoopSpanProcessor()
  #contextManager = new ContextManager()
  #processors = []
  #tracers = new Map()

  constructor (config = {}) {
    this.config = config
    this.resource = config.resource

    // @opentelemetry/sdk-trace 2.x (used by @opentelemetry/sdk-node 0.220+)
    // dropped `addSpanProcessor` and hands the processors to the provider
    // constructor instead. Wire them the same way the 1.x `addSpanProcessor`
    // path does, so a NodeSDK configured with a trace exporter or custom
    // processors still delivers onStart/onEnd to them.
    if (Array.isArray(config.spanProcessors)) {
      for (const spanProcessor of config.spanProcessors) {
        this.addSpanProcessor(spanProcessor)
      }
    }
  }

  getTracer (name = 'opentelemetry', version = '0.0.0', options) {
    const key = `${name}@${version}`
    if (!this.#tracers.has(key)) {
      this.#tracers.set(key, new Tracer(
        { ...options, name, version },
        this.config,
        this
      ))
    }
    return this.#tracers.get(key)
  }

  /**
   * @param {NoopSpanProcessor} spanProcessor
   */
  addSpanProcessor (spanProcessor) {
    if (this.#processors.includes(spanProcessor)) return

    if (!this.#processors.length) {
      this.#activeProcessor.shutdown()
    }
    this.#processors.push(spanProcessor)
    this.#activeProcessor = new MultiSpanProcessor(
      this.#processors
    )
  }

  getActiveSpanProcessor () {
    return this.#activeProcessor
  }

  // Not actually required by the SDK spec, but the official Node.js SDK does
  // this and the docs reflect that so we should do this too for familiarity.
  register (config = {}) {
    // Read the API at register time, not module load: the application's copy is captured when it
    // requires @opentelemetry/api, which may happen after this module was first loaded. Registering
    // on a copy snapshotted before capture would bind the global provider to dd-trace's fallback
    // copy while the application reads its own, downgrading every span to a no-op (issue #6882).
    const { trace, context, propagation } = getApi()
    context.setGlobalContextManager(this.#contextManager)
    if (!trace.setGlobalTracerProvider(this)) {
      trace.getTracerProvider().setDelegate(this)
    }
    // The default propagator used is the W3C Trace Context propagator, users should be able to pass in others
    // as needed
    if (config.propagator) {
      propagation.setGlobalPropagator(config.propagator)
    } else {
      propagation.setGlobalPropagator(new W3CTraceContextPropagator())
    }
  }

  forceFlush () {
    const exporter = tracer._tracer._exporter
    if (!exporter) {
      return Promise.reject(new Error('Not started'))
    }

    exporter._writer?.flush()
    return this.#activeProcessor.forceFlush()
  }

  shutdown () {
    return this.#activeProcessor.shutdown()
  }
}

module.exports = TracerProvider
