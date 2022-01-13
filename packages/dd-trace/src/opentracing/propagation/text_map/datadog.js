'use strict'

const DatadogSpanContext = require('../../span_context')
const id = require('../../../id')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const tagsKey = 'x-datadog-tags'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)

class DatadogPropagator {
  inject (spanContext, carrier) {
    carrier[traceKey] = spanContext._traceId.toString(10)
    carrier[spanKey] = spanContext._spanId.toString(10)

    this._injectOrigin(spanContext, carrier)
    this._injectSamplingPriority(spanContext, carrier)
    this._injectBaggageItems(spanContext, carrier)
    this._injectTags(spanContext, carrier)
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) return null // TODO: validate

    const traceId = id(carrier[traceKey], 10)
    const spanId = carrier[spanKey] ? id(carrier[spanKey], 10) : null
    const origin = this._extractOrigin(carrier)
    const baggageItems = this._extractBaggageItems(carrier)
    const priority = this._extractSamplingPriority(carrier)
    const tags = this._extractTags(carrier)
    const sampling = priority !== undefined && { priority }
    const trace = origin ? { origin, tags } : { tags }

    return new DatadogSpanContext({
      traceId,
      spanId,
      baggageItems,
      sampling,
      trace
    })
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
    for (const key in spanContext._baggageItems) {
      carrier[baggagePrefix + key] = String(spanContext._baggageItems[key])
    }
  }

  _injectTags (spanContext, carrier) {
    const trace = spanContext._trace
    const tags = []

    for (const key in trace.tags) {
      if (!key.startsWith('_dd.p.')) continue

      tags.push(`${key}=${trace.tags[key]}`)
    }

    const header = tags.join(',')

    if (header.length <= 512) {
      carrier[tagsKey] = header
    } else {
      trace.tags['_dd.propagation_error:max_size'] = 1
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

  _extractTags (carrier) {
    const tags = {}

    if (typeof carrier[tagsKey] === 'string') {
      const pairs = carrier[tagsKey].split(',')

      for (const pair of pairs) {
        const [key, value] = pair.split('=')

        tags[key] = value
      }
    }

    return tags
  }
}

module.exports = { DatadogPropagator }
