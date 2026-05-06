'use strict'

const api = require('@opentelemetry/api')
const { sanitizeAttributes } = require('../../../../vendor/dist/@opentelemetry/core')

const tracer = require('../../')

const id = require('../id')
const log = require('../log')
const TextMapPropagator = require('../opentracing/propagation/text_map')
const TraceState = require('../opentracing/propagation/tracestate')
const SpanContext = require('./span_context')
const Span = require('./span')
const Sampler = require('./sampler')
const { normalizeLinkContext } = require('./span-helpers')

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
      tracestate: parentSpanContext._tracestate,
    })
  }

  // Extracted method to create span context for a new span
  _createSpanContextForNewSpan (context) {
    const { traceId, spanId, traceFlags, traceState } = context
    return this._convertOtelContextToDatadog(traceId, spanId, traceFlags, traceState)
  }

  _convertOtelContextToDatadog (traceId, spanId, traceFlag, ts, meta = {}) {
    let origin = null
    let samplingPriority = traceFlag

    ts = ts?.traceparent

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
        origin = ddTraceStateData.get('o') ?? null
        // Convert Map to object for meta
        const otherPropagatedTags = Object.fromEntries(ddTraceStateData.entries())

        // Update meta and samplingPriority based on extracted values
        Object.assign(meta, otherPropagatedTags)
        // Guard against an undefined/empty `s:` field that would result in NaN.
        const tracestateSamplingPriority = samplingPriorityTs ? Math.trunc(samplingPriorityTs) : undefined
        samplingPriority = TextMapPropagator._getSamplingPriority(traceFlag, tracestateSamplingPriority, origin)
      } else {
        log.debug('No dd list member in tracestate from incoming request:', ts)
      }
    }

    const spanContext = new SpanContext({
      traceId: id(traceId, 16), spanId: id(), tags: meta, parentId: id(spanId, 16),
    })

    spanContext._ddContext._sampling = { priority: samplingPriority }
    spanContext._ddContext._trace = { ...spanContext._ddContext._trace, origin }
    return spanContext
  }

  startSpan (name, options = {}, context = api.context.active()) {
    // remove span from context in case a root span is requested via options
    if (options.root) {
      context = api.trace.deleteSpan(context)
    }
    const parentSpan = api.trace.getSpan(context)
    const parentSpanContext = parentSpan?.spanContext()
    let spanContext
    if (parentSpanContext && api.trace.isSpanContextValid(parentSpanContext)) {
      spanContext = parentSpanContext._ddContext
        ? this._createSpanContextFromParent(parentSpanContext._ddContext)
        : this._createSpanContextForNewSpan(parentSpanContext)
    } else {
      spanContext = new SpanContext()
    }

    // init() didn't finish setting up real tracing (e.g. DD_TRACE_ENABLED=false,
    // or init() was never called), so the inner tracer is still the noop.
    // DatadogSpan can't construct without a processor + prioritySampler, so fall
    // through to a non-recording span; the SpanContext still propagates.
    if (!tracer._tracingInitialized) {
      return api.trace.wrapSpanContext(spanContext)
    }

    const spanKind = options.kind || api.SpanKind.INTERNAL
    const links = []
    if (options.links?.length) {
      for (const link of options.links) {
        const ddContext = normalizeLinkContext(link?.context)
        if (!ddContext) continue

        links.push({
          context: ddContext,
          attributes: sanitizeAttributes(link.attributes),
        })
      }
    }
    const attributes = sanitizeAttributes(options.attributes)

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
