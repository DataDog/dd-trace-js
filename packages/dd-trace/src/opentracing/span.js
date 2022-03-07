'use strict'

const opentracing = require('opentracing')
const Span = opentracing.Span
const SpanContext = require('./span_context')

const {
  MANUAL_KEEP,
  MANUAL_DROP,
  SERVICE_NAME,
  SPAN_TYPE,
  RESOURCE_NAME,
  SPAN_KIND,
  MEASURED,
  ERROR,
  HTTP_STATUS_CODE
} = require('../../../../ext/tags')

class DatadogSpan extends Span {
  constructor (parentTracer, span) {
    super()

    this._parentTracer = parentTracer
    this._span = span
    this._spanContext = new SpanContext(span)
  }

  toString () {
    const spanContext = this.context()
    const resourceName = spanContext._tags['resource.name']
    const resource = resourceName.length > 100
      ? `${resourceName.substring(0, 97)}...`
      : resourceName
    const json = JSON.stringify({
      traceId: spanContext._traceId,
      spanId: spanContext._spanId,
      parentId: spanContext._parentId,
      service: spanContext._tags['service.name'],
      name: spanContext._name,
      resource
    })

    return `Span${json}`
  }

  _context () {
    return this._spanContext
  }

  _tracer () {
    return this._parentTracer
  }

  _setOperationName (name) {
    this._span.name = name
  }

  _setBaggageItem (key, value) {
    this._span.setBaggageItem(key, value)
  }

  _getBaggageItem (key) {
    return this._span.getBaggageItem(key)
  }

  _addTags (keyValuePairs) {
    const span = this._span

    for (const key in keyValuePairs) {
      const value = keyValuePairs[key]

      switch (key) {
        case ERROR:
          span.addError(value)
          break
        case HTTP_STATUS_CODE: // HACK: numeric but backend expects string
          span.setTag(key, String(value))
          break
        case MANUAL_DROP:
          span.sample(false)
          break
        case MANUAL_KEEP:
          span.sample(true)
          break
        case MEASURED:
          span.measured = value
          break
        case RESOURCE_NAME:
          span.resource = value
          break
        case SERVICE_NAME:
          span.service = value
          break
        case SPAN_KIND:
          span.kind = value
          break
        case SPAN_TYPE:
          span.type = value
          break
        default:
          span.setTag(key, value)
      }
    }
  }

  _finish (finishTime) {
    this._span.finish(finishTime)
  }
}

module.exports = DatadogSpan
