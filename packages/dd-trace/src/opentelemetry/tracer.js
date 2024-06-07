'use strict'

const api = require('@opentelemetry/api')
const { sanitizeAttributes } = require('@opentelemetry/core')

const Sampler = require('./sampler')
const Span = require('./span')
const id = require('../id')
const SpanContext = require('./span_context')

class Tracer {
  constructor (library, config, tracerProvider) {
    this._sampler = new Sampler()
    this._config = config
    this._tracerProvider = tracerProvider
    // Is there a reason this is public?
    this.instrumentationLibrary = library
  }

  get resource () {
    return this._tracerProvider.resource
  }

  startSpan (name, options = {}, context = api.context.active()) {
    // remove span from context in case a root span is requested via options
    if (options.root) {
      context = api.trace.deleteSpan(context)
    }
    const parentSpan = api.trace.getSpan(context)
    const parentSpanContext = parentSpan && parentSpan.spanContext()

    let spanContext
    // TODO: Need a way to get 128-bit trace IDs for the validity check API to work...
    // if (parent && api.trace.isSpanContextValid(parent)) {
    if (parentSpanContext && parentSpanContext.traceId) {
      const parent = parentSpanContext._ddContext
      spanContext = new SpanContext({
        traceId: parent._traceId,
        spanId: id(),
        parentId: parent._spanId,
        sampling: parent._sampling,
        baggageItems: Object.assign({}, parent._baggageItems),
        trace: parent._trace,
        tracestate: parent._tracestate
      })
    } else {
      spanContext = new SpanContext()
    }

    const spanKind = options.kind || api.SpanKind.INTERNAL
    const links = (options.links || []).map(link => {
      return {
        context: link.context,
        attributes: sanitizeAttributes(link.attributes)
      }
    })
    const attributes = sanitizeAttributes(options.attributes)

    // TODO: sampling API is not yet supported
    // // make sampling decision
    // const samplingResult = this._sampler.shouldSample(
    //   context,
    //   spanContext.traceId,
    //   name,
    //   spanKind,
    //   attributes,
    //   links
    // )

    // // Should use new span context
    // spanContext._ddContext._sampling.priority =
    //   samplingResult.decision === api.SamplingDecision.RECORD_AND_SAMPLED
    //     ? AUTO_KEEP
    //     : AUTO_REJECT

    // if (samplingResult.decision === api.SamplingDecision.NOT_RECORD) {
    //   api.diag.debug('Recording is off, propagating context in a non-recording span')
    //   return api.trace.wrapSpanContext(spanContext)
    // }

    return new Span(
      this,
      context,
      name,
      spanContext,
      spanKind,
      links,
      options.startTime,

      // Set initial span attributes. The attributes object may have been mutated
      // by the sampler, so we sanitize the merged attributes before setting them.
      sanitizeAttributes(
        // Object.assign(attributes, samplingResult.attributes)
        attributes
      )
    )
  }

  startActiveSpan (name, options, context, fn) {
    if (arguments.length === 2) {
      fn = options
      context = undefined
      options = undefined
    } else if (arguments.length === 3) {
      fn = context
      context = undefined
    } else if (arguments.length !== 4) {
      return
    }

    const parentContext = context || api.context.active()
    const span = this.startSpan(name, options, parentContext)
    const contextWithSpanSet = api.trace.setSpan(parentContext, span)

    return api.context.with(contextWithSpanSet, fn, undefined, span)
  }

  getActiveSpanProcessor () {
    return this._tracerProvider.getActiveSpanProcessor()
  }
}

module.exports = Tracer
