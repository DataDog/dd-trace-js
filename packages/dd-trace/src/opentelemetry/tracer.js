'use strict'

const api = require('@opentelemetry/api')
const { sanitizeAttributes } = require('@opentelemetry/core')

const Sampler = require('./sampler')
const Span = require('./span')
const id = require('../id')
const log = require('../log')
const SpanContext = require('./span_context')
const TextMapPropagator = require('../opentracing/propagation/text_map')
const TraceState = require('../opentracing/propagation/tracestate')

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
      baggageItems: { ...parentSpanContext._baggageItems },
      trace: parentSpanContext._trace,
      tracestate: parentSpanContext._tracestate
    })
  }

  // Extracted method to create span context for a new span
  _createSpanContextForNewSpan (context) {
    const { traceId, spanId, traceFlags, traceState } = context
    return this._convertOtelContextToDatadog(traceId, spanId, traceFlags, traceState)
  }

  _convertOtelContextToDatadog (traceId, spanId, traceFlag, ts, meta = {}) {
    const origin = null
    let samplingPriority = traceFlag

    ts = ts?.traceparent || null

    if (ts) {
      // Use TraceState.fromString to parse the tracestate header
      const traceState = TraceState.fromString(ts)
      let ddTraceStateData = null

      // Extract Datadog specific trace state data
      traceState.forVendor('dd', (state) => {
        ddTraceStateData = state
        return state // You might need to adjust this part based on actual logic needed
      })

      if (ddTraceStateData) {
        // Assuming ddTraceStateData is now a Map or similar structure containing Datadog trace state data
        // Extract values as needed, similar to the original logic
        const samplingPriorityTs = ddTraceStateData.get('s')
        const origin = ddTraceStateData.get('o')
        // Convert Map to object for meta
        const otherPropagatedTags = Object.fromEntries(ddTraceStateData.entries())

        // Update meta and samplingPriority based on extracted values
        Object.assign(meta, otherPropagatedTags)
        samplingPriority = TextMapPropagator._getSamplingPriority(
          traceFlag,
          Number.parseInt(samplingPriorityTs, 10),
          origin
        )
      } else {
        log.debug('no dd list member in tracestate from incoming request:', ts)
      }
    }

    const spanContext = new SpanContext({
      traceId: id(traceId, 16), spanId: id(), tags: meta, parentId: id(spanId, 16)
    })

    spanContext._sampling = { priority: samplingPriority }
    spanContext._trace = { origin }
    return spanContext
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
      sanitizeAttributes(attributes)
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
