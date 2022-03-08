'use strict'

const { id, zeroId } = require('../../id')
const { Trace } = require('../../trace')

const traceKey = 'x-datadog-trace-id'
const spanKey = 'x-datadog-parent-id'
const originKey = 'x-datadog-origin'
const samplingKey = 'x-datadog-sampling-priority'
const tagsKey = 'x-datadog-tags'
const baggagePrefix = 'ot-baggage-'
const baggageExpr = new RegExp(`^${baggagePrefix}(.+)$`)

class DatadogPropagator {
  inject (span, carrier) {
    carrier[traceKey] = span.trace.traceId.toString()
    carrier[spanKey] = span.spanId.toString()

    this._injectOrigin(span, carrier)
    this._injectSamplingPriority(span, carrier)
    this._injectBaggageItems(span, carrier)
    this._injectTags(span, carrier)
  }

  extract (carrier) {
    if (!carrier[traceKey] || !carrier[spanKey]) return null // TODO: validate

    const traceId = id(carrier[traceKey])
    const spanId = id(carrier[spanKey])
    const origin = this._extractOrigin(carrier)
    const baggage = this._extractBaggageItems(carrier)
    const samplingPriority = this._extractSamplingPriority(carrier)
    const meta = this._extractTags(carrier)

    return {
      trace: new Trace({
        traceId,
        samplingPriority,
        meta,
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

  _injectTags (span, carrier) {
    const trace = span.trace
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

    for (const key of carrier) {
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
