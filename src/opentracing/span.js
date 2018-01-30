'use strict'

const opentracing = require('opentracing')
const Span = opentracing.Span
const SpanContext = require('./span_context')
const platform = require('../platform')

class DatadogSpan extends Span {
  constructor (tracer, fields) {
    super()

    const startTime = fields.startTime || platform.now()
    const operationName = fields.operationName
    const parent = fields.parent || null
    const tags = fields.tags || {}

    this._parentTracer = tracer
    this._operationName = operationName
    this._tags = Object.assign({}, tags)
    this._startTime = startTime

    if (parent) {
      this._spanContext = new SpanContext({
        traceId: parent.traceId,
        spanId: platform.id(),
        sampled: parent.sampled,
        baggageItems: Object.assign({}, parent.baggageItems)
      })

      this._parentId = parent.spanId
    } else {
      this._spanContext = new SpanContext({
        traceId: platform.id(),
        spanId: platform.id(),
        sampled: this._parentTracer._isSampled(this),
        baggageItems: {}
      })

      this._parentId = null
    }
  }

  _context () {
    return this._spanContext
  }

  _tracer () {
    return this._parentTracer
  }

  _setOperationName (name) {
    this._operationName = name
  }

  _setBaggageItem (key, value) {
    this._spanContext.baggageItems[key] = value
  }

  _getBaggageItem (key) {
    return this._spanContext.baggageItems[key]
  }

  _addTags (keyValuePairs) {
    Object.keys(keyValuePairs).forEach(key => {
      this._tags[key] = String(keyValuePairs[key])
    })
  }

  _finish (finishTime) {
    finishTime = finishTime || platform.now()

    this._duration = finishTime - this._startTime

    if (this._spanContext.sampled) {
      this._parentTracer._record(this)
    }
  }
}

module.exports = DatadogSpan
