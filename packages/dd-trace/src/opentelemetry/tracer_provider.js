'use strict'

const { trace, context, propagation } = require('@opentelemetry/api')
const { W3CTraceContextPropagator } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')

const ContextManager = require('./context_manager')
const { MultiSpanProcessor, NoopSpanProcessor, settleAllFlushes } = require('./span_processor')
const Tracer = require('./tracer')

/**
 * @typedef {{
 *   flush?: (done?: (error?: Error) => void, options?: { reportErrors?: boolean }) => void
 * }} TraceExporter
 */

/**
 * @param {TraceExporter} exporter
 * @returns {Promise<void>}
 */
function flushExporter (exporter) {
  if (typeof exporter.flush !== 'function') return Promise.resolve()

  /**
   * @param {() => void} resolve
   * @param {(reason?: unknown) => void} reject
   */
  function flush (resolve, reject) {
    /**
     * @param {Error} [error]
     */
    function done (error) {
      if (error) reject(error)
      else resolve()
    }

    exporter.flush(done, { reportErrors: true })
  }

  return new Promise(flush)
}

class TracerProvider {
  #activeProcessor = new NoopSpanProcessor()
  #contextManager = new ContextManager()
  #flush
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

    const flush = () => settleAllFlushes([
      flushExporter(exporter),
      this.#activeProcessor.forceFlush(),
    ])
    const pending = this.#flush ? this.#flush.then(flush, flush) : flush()
    this.#flush = pending

    const clear = () => {
      if (this.#flush === pending) this.#flush = undefined
    }
    pending.then(clear, clear)

    return pending
  }

  shutdown () {
    return this.#activeProcessor.shutdown()
  }
}

module.exports = TracerProvider
