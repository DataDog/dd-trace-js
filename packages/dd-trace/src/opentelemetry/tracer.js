'use strict'

const api = require('@opentelemetry/api')
const { sanitizeAttributes } = require('@opentelemetry/core')

const Sampler = require('./sampler')
const Span = require('./span')
const id = require('../id')
const SpanContext = require('./span_context')
const TextMapPropagator = require('../opentracing/propagation/text_map')

class Tracer {
  constructor (library, config, tracerProvider) {
    this._sampler = new Sampler()
    this._config = config
    this._tracerProvider = tracerProvider
    // Is there a reason this is public?
    this.instrumentationLibrary = library
    this._isOtelLibrary = library?.name?.startsWith('@opentelemetry/instrumentation-')
    this._spanLimits = {}
  }

  get resource () {
    return this._tracerProvider.resource
  }

  _createSpanContextFromParent (parentSpanContext) {
    return new SpanContext({
      traceId: parentSpanContext._traceId,
      spanId: id(),
      parentId: parentSpanContext._spanId,
      sampling: parentSpanContext._sampling,
      baggageItems: Object.assign({}, parentSpanContext._baggageItems),
      trace: parentSpanContext._trace,
      tracestate: parentSpanContext._tracestate
    })
  }

  // Extracted method to create span context for a new span
  _createSpanContextForNewSpan (context) {
    const { traceId, spanId, traceFlags, traceState } = context
    return TextMapPropagator._convertOtelContextToDatadog(traceId, spanId, traceFlags, traceState)
  }

  startSpan (name, options = {}, context = api.context.active()) {
    // remove span from context in case a root span is requested via options
    if (options.root) {
      context = api.trace.deleteSpan(context)
    }
    const parentSpan = api.trace.getSpan(context)
    const parentSpanContext = parentSpan && parentSpan.spanContext()
    let spanContext
    if (parentSpanContext && api.trace.isSpanContextValid(parentSpanContext)) {
      spanContext = parentSpanContext._ddContext
        ? this._createSpanContextFromParent(parentSpanContext._ddContext)
        : this._createSpanContextForNewSpan(parentSpanContext)
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

  // not used in our codebase but needed for compatibility. See issue #1244
  getSpanLimits () {
    return this._spanLimits
  }
}

module.exports = Tracer
