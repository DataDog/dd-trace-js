'use strict'

const pick = require('lodash.pick')
const platform = require('../../platform')
const DatadogSpanContext = require('../span_context')
const NoopSpanContext = require('../../noop/span_context')
const log = require('../../log')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const b3TraceKey = 'x-b3-traceid'
const b3TraceExpr = /^\s*([0-9a-f]{16}){1,2}\s*$/i
const b3SpanKey = 'x-b3-spanid'
const b3SpanExpr = /^\s*[0-9a-f]{16}\s*$/i
const b3ParentKey = 'x-b3-parentspanid'
const b3SampledKey = 'x-b3-sampled'
const b3FlagsKey = 'x-b3-flags'
const b3HeaderKey = 'b3'
const b3HeaderExpr = /^\s*(([0-9a-f]{16}){1,2}-[0-9a-f]{16}-[01d](-[0-9a-f]{16})?|0)\s*$/i
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)
const ddKeys = [traceKey, spanKey, samplingKey, originKey]
const b3Keys = [b3TraceKey, b3SpanKey, b3ParentKey, b3SampledKey, b3FlagsKey, b3HeaderKey]
const logKeys = ddKeys.concat(b3Keys)

class TextMapPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext.toTraceId()
    carrier[spanKey] = spanContext.toSpanId()

    this._injectOrigin(spanContext, carrier)
    this._injectSamplingPriority(spanContext, carrier)
    this._injectBaggageItems(spanContext, carrier)
    this._injectB3(spanContext, carrier)

    log.debug(() => `Inject into carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)
  }

  extract (carrier) {
    const spanContext = this._extractSpanContext(carrier)

    if (!spanContext) return spanContext

    this._extractOrigin(carrier, spanContext)
    this._extractBaggageItems(carrier, spanContext)
    this._extractSamplingPriority(carrier, spanContext)

    log.debug(() => `Extract from carrier: ${JSON.stringify(pick(carrier, logKeys))}.`)

    return spanContext
  }

  _injectOrigin (spanContext, carrier) {
    const origin = spanContext._trace.origin

    if (origin) {
      carrier[originKey] = origin
    }
  }

  _injectSamplingPriority (spanContext, carrier) {
    const priority = spanContext._sampling.priority

    if (Number.isInteger(priority)) {
      carrier[samplingKey] = priority.toString()
    }
  }

  _injectBaggageItems (spanContext, carrier) {
    spanContext._baggageItems && Object.keys(spanContext._baggageItems).forEach(key => {
      carrier[baggagePrefix + key] = String(spanContext._baggageItems[key])
    })
  }

  _injectB3 (spanContext, carrier) {
    carrier[b3TraceKey] = spanContext._traceId.toString('hex')
    carrier[b3SpanKey] = spanContext._spanId.toString('hex')
    carrier[b3SampledKey] = spanContext._traceFlags.sampled ? '1' : '0'

    if (spanContext._parentId) {
      carrier[b3ParentKey] = spanContext._parentId.toString('hex')
    }
  }

  _extractSpanContext (carrier) {
    const context = this._extractContext(carrier)

    if (!context) return null

    if (context.traceFlags.sampled) {
      return new DatadogSpanContext(context)
    } else {
      return new NoopSpanContext(context)
    }
  }

  _extractContext (carrier) {
    const b3 = this._extractB3Headers(carrier)
    const debug = carrier[b3FlagsKey] === '1'
    const sampled = debug || carrier[b3SampledKey] === '1' || !carrier[b3SampledKey]
    const traceFlags = {
      sampled
    }

    if (b3) {
      return {
        traceId: platform.id(b3[b3TraceKey]),
        spanId: platform.id(b3[b3SpanKey]),
        traceFlags
      }
    } else if (carrier[traceKey] && carrier[spanKey]) {
      return {
        traceId: platform.id(carrier[traceKey], 10),
        spanId: platform.id(carrier[spanKey], 10),
        traceFlags
      }
    } else if (!sampled) {
      return {
        traceId: platform.id(),
        spanId: platform.id(),
        traceFlags
      }
    }

    return null
  }

  _extractB3Headers (carrier) {
    if (b3HeaderExpr.test(carrier[b3HeaderKey])) {
      return this._extractB3SingleHeader(carrier)
    } else if (b3TraceExpr.test(carrier[b3TraceKey]) && b3SpanExpr.test(carrier[b3SpanKey])) {
      return this._extractB3MultipleHeaders(carrier)
    }

    return null
  }

  _extractB3MultipleHeaders (carrier) {
    const b3 = {
      [b3TraceKey]: carrier[b3TraceKey],
      [b3SpanKey]: carrier[b3SpanKey]
    }

    if (carrier[b3SampledKey]) {
      b3[b3SampledKey] = carrier[b3SampledKey]
    }

    if (carrier[b3FlagsKey]) {
      b3[b3FlagsKey] = carrier[b3FlagsKey]
    }

    return b3
  }

  _extractB3SingleHeader (carrier) {
    const parts = carrier[b3HeaderKey].trim().split('-')

    if (parts.length < 3) {
      return {
        [b3TraceKey]: '0000000000000000',
        [b3SpanKey]: '0000000000000000',
        [b3SampledKey]: '0'
      }
    } else {
      const b3 = {
        [b3TraceKey]: parts[0],
        [b3SpanKey]: parts[1],
        [b3SampledKey]: parts[2] !== '0' ? '1' : '0'
      }

      if (parts[2] === 'd') {
        b3[b3FlagsKey] = '1'
      }

      return b3
    }
  }

  _extractOrigin (carrier, spanContext) {
    const origin = carrier[originKey]

    if (typeof carrier[originKey] === 'string') {
      spanContext._trace.origin = origin
    }
  }

  _extractBaggageItems (carrier, spanContext) {
    Object.keys(carrier).forEach(key => {
      const match = key.match(baggageExpr)

      if (match) {
        spanContext._baggageItems[match[1]] = carrier[key]
      }
    })
  }

  _extractSamplingPriority (carrier, spanContext) {
    const priority = parseInt(carrier[samplingKey], 10)

    if (Number.isInteger(priority)) {
      spanContext._sampling.priority = parseInt(carrier[samplingKey], 10)
    }
  }
}

module.exports = TextMapPropagator
