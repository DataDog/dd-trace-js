'use strict'

const { trace, context, propagation } = require('@opentelemetry/api')
const { W3CTraceContextPropagator } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')

const ContextManager = require('./context_manager')
const { MultiSpanProcessor, NoopSpanProcessor } = require('./span_processor')
const Tracer = require('./tracer')

class TracerProvider {
  #processors
  #tracers
  #activeProcessor
  #contextManager

  constructor (config = {}) {
    this.config = config
    this.resource = config.resource

    this.#processors = []
    this.#tracers = new Map()
    this.#activeProcessor = new NoopSpanProcessor()
    this.#contextManager = new ContextManager()
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

  addSpanProcessor (spanProcessor) {
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

    exporter._writer.flush()
    return this.#activeProcessor.forceFlush()
  }

  shutdown () {
    return this.#activeProcessor.shutdown()
  }

  // Exposed for test access
  get _processors () { return this.#processors }
}

module.exports = TracerProvider
