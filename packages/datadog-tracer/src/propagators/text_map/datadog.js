'use strict'

const { id, zeroId } = require('../../id')
const { Trace } = require('../../trace')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)

class DatadogPropagator {
  inject (span, carrier) {
    carrier[traceKey] = span.trace.traceId.toString()
    carrier[spanKey] = span.spanId.toString()

    this._injectOrigin(span, carrier)
    this._injectSamplingPriority(span, carrier)
    this._injectBaggageItems(span, carrier)
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) return null // TODO: validate

    const traceId = id(carrier[traceKey])
    const spanId = id(carrier[spanKey])
    const origin = this._extractOrigin(carrier)
    const baggage = this._extractBaggageItems(carrier)
    const samplingPriority = this._extractSamplingPriority(carrier)

    return {
      trace: new Trace({
        traceId,
        samplingPriority,
        origin
      }),
      spanId,
      parentId: zeroId,
      baggage
    }
  }

  _injectOrigin (span, carrier) {
    const origin = span.trace.origin

    if (origin) {
      carrier[originKey] = origin
    }
  }

  _injectSamplingPriority (span, carrier) {
    const priority = span.trace.samplingPriority

    if (Number.isInteger(priority)) {
      carrier[samplingKey] = priority.toString()
    }
  }

  _injectBaggageItems (span, carrier) {
    for (const key in span.trace.baggage) {
      carrier[baggagePrefix + key] = String(span.baggage[key])
    }
  }

  _extractOrigin (carrier) {
    return typeof carrier[originKey] === 'string' && carrier[originKey]
  }

  _extractBaggageItems (carrier) {
    const baggage = {}

    for (const key in carrier) {
      const match = key.match(baggageExpr)

      if (match) {
        baggage[match[1]] = carrier[key]
      }
    }

    return baggage
  }

  _extractSamplingPriority (carrier) {
    const priority = parseInt(carrier[samplingKey], 10)

    if (Number.isInteger(priority)) {
      return priority
    }
  }
}

module.exports = { DatadogPropagator }
