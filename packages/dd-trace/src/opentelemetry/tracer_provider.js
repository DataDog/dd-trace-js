'use strict'

const { W3CTraceContextPropagator } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')
const { getApi } = require('./api')

const ContextManager = require('./context_manager')
const { MultiSpanProcessor, NoopSpanProcessor } = require('./span_processor')
const Tracer = require('./tracer')

class TracerProvider {
  constructor (config = {}) {
    this.config = config
    this.resource = config.resource

    this._processors = []
    this._tracers = new Map()
    this._activeProcessor = new NoopSpanProcessor()
    this._contextManager = new ContextManager()
  }

  getTracer (name = 'opentelemetry', version = '0.0.0', options) {
    const key = `${name}@${version}`
    if (!this._tracers.has(key)) {
      this._tracers.set(key, new Tracer(
        { ...options, name, version },
        this.config,
        this
      ))
    }
    return this._tracers.get(key)
  }

  addSpanProcessor (spanProcessor) {
    if (!this._processors.length) {
      this._activeProcessor.shutdown()
    }
    this._processors.push(spanProcessor)
    this._activeProcessor = new MultiSpanProcessor(
      this._processors
    )
  }

  getActiveSpanProcessor () {
    return this._activeProcessor
  }

  // Not actually required by the SDK spec, but the official Node.js SDK does
  // this and the docs reflect that so we should do this too for familiarity.
  register (config = {}) {
    // Read the API at register time, not module load: the application's copy is captured when it
    // requires @opentelemetry/api, which may happen after this module was first loaded. Registering
    // on a copy snapshotted before capture would bind the global provider to dd-trace's fallback
    // copy while the application reads its own, downgrading every span to a no-op (issue #6882).
    const { trace, context, propagation } = getApi()
    context.setGlobalContextManager(this._contextManager)
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
    return this._activeProcessor.forceFlush()
  }

  shutdown () {
    return this._activeProcessor.shutdown()
  }
}

module.exports = TracerProvider
