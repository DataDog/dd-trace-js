'use strict'

const pick = require('lodash.pick')
const id = require('../../id')
const DatadogSpanContext = require('../span_context')
const log = require('../../log')

const { AUTO_KEEP, AUTO_REJECT, USER_KEEP } = require('../../../../../ext/priority')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const b3TraceKey = 'x-b3-traceid'
const b3TraceExpr = /^([0-9a-f]{16}){1,2}$/i
const b3SpanKey = 'x-b3-spanid'
const b3SpanExpr = /^[0-9a-f]{16}$/i
const b3ParentKey = 'x-b3-parentspanid'
const b3SampledKey = 'x-b3-sampled'
const b3FlagsKey = 'x-b3-flags'
const b3HeaderKey = 'b3'
const sqsdHeaderHey = 'x-aws-sqsd-attr-_datadog'
const b3HeaderExpr = /^(([0-9a-f]{16}){1,2}-[0-9a-f]{16}(-[01d](-[0-9a-f]{16})?)?|[01d])$/i
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)
const ddKeys = [traceKey, spanKey, samplingKey, originKey]
const b3Keys = [b3TraceKey, b3SpanKey, b3ParentKey, b3SampledKey, b3FlagsKey, b3HeaderKey]
const logKeys = ddKeys.concat(b3Keys)

class TextMapPropagator {
  constructor (config) {
    this._config = config
  }

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
    if (!this._config.experimental.b3) return

    carrier[b3TraceKey] = spanContext._traceId.toString('hex')
    carrier[b3SpanKey] = spanContext._spanId.toString('hex')
    carrier[b3SampledKey] = spanContext._sampling.priority >= AUTO_KEEP ? '1' : '0'

    if (spanContext._sampling.priority > AUTO_KEEP) {
      carrier[b3FlagsKey] = '1'
    }

    if (spanContext._parentId) {
      carrier[b3ParentKey] = spanContext._parentId.toString('hex')
    }
  }

  _extractSpanContext (carrier) {
    return this._extractDatadogContext(carrier) || this._extractB3Context(carrier) || this._extractSqsdContext(carrier)
  }

  _extractDatadogContext (carrier) {
    const spanContext = this._extractGenericContext(carrier, traceKey, spanKey, 10)

    if (spanContext) {
      this._extractOrigin(carrier, spanContext)
      this._extractBaggageItems(carrier, spanContext)
      this._extractSamplingPriority(carrier, spanContext)
    }

    return spanContext
  }

  _extractB3Context (carrier) {
    if (!this._config.experimental.b3) return null

    const b3 = this._extractB3Headers(carrier)
    const debug = b3[b3FlagsKey] === '1'
    const priority = this._getPriority(b3[b3SampledKey], debug)
    const spanContext = this._extractGenericContext(b3, b3TraceKey, b3SpanKey)

    if (priority !== undefined) {
      if (!spanContext) {
        // B3 can force a sampling decision without providing IDs
        return new DatadogSpanContext({
          traceId: id(),
          spanId: null,
          sampling: { priority }
        })
      }

      spanContext._sampling.priority = priority
    }

    return spanContext
  }

  _extractSqsdContext (carrier) {
    const headerValue = carrier[sqsdHeaderHey]
    if (!headerValue) {
      return null
    }
    let parsed
    try {
      parsed = JSON.parse(headerValue)
    } catch (e) {
      return null
    }
    return this._extractDatadogContext(parsed)
  }

  _extractGenericContext (carrier, traceKey, spanKey, radix) {
    if (carrier[traceKey] && carrier[spanKey]) {
      return new DatadogSpanContext({
        traceId: id(carrier[traceKey], radix),
        spanId: id(carrier[spanKey], radix)
      })
    }

    return null
  }

  _extractB3Headers (carrier) {
    if (b3HeaderExpr.test(carrier[b3HeaderKey])) {
      return this._extractB3SingleHeader(carrier)
    } else {
      return this._extractB3MultipleHeaders(carrier)
    }
  }

  _extractB3MultipleHeaders (carrier) {
    const b3 = {}

    if (b3TraceExpr.test(carrier[b3TraceKey]) && b3SpanExpr.test(carrier[b3SpanKey])) {
      b3[b3TraceKey] = carrier[b3TraceKey]
      b3[b3SpanKey] = carrier[b3SpanKey]
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
    const parts = carrier[b3HeaderKey].split('-')

    if (parts[0] === 'd') {
      return {
        [b3SampledKey]: '1',
        [b3FlagsKey]: '1'
      }
    } else if (parts.length === 1) {
      return {
        [b3SampledKey]: parts[0]
      }
    } else {
      const b3 = {
        [b3TraceKey]: parts[0],
        [b3SpanKey]: parts[1]
      }

      if (parts[2]) {
        b3[b3SampledKey] = parts[2] !== '0' ? '1' : '0'

        if (parts[2] === 'd') {
          b3[b3FlagsKey] = '1'
        }
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

  _getPriority (sampled, debug) {
    if (debug) {
      return USER_KEEP
    } else if (sampled === '1') {
      return AUTO_KEEP
    } else if (sampled === '0') {
      return AUTO_REJECT
    }
  }
}

module.exports = TextMapPropagator
