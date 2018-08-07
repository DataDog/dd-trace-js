'use strict'

const opentracing = require('opentracing')
const Span = opentracing.Span
const SpanContext = require('./span_context')
const platform = require('../platform')
const log = require('../log')

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

    this._spanContext = this._createContext(parent)
  }

  _createContext (parent) {
    let spanContext

    if (parent) {
      spanContext = new SpanContext({
        traceId: parent.traceId,
        spanId: platform.id(),
        samplingPriority: parent.samplingPriority,
        parentId: parent.spanId,
        sampled: parent.sampled,
        baggageItems: Object.assign({}, parent.baggageItems),
        trace: parent.trace
      })
    } else {
      const spanId = platform.id()
      spanContext = new SpanContext({
        traceId: spanId,
        spanId,
        sampled: this._parentTracer._isSampled(this)
      })
    }

    spanContext.trace.started.push(this)

    return spanContext
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
    try {
      Object.keys(keyValuePairs).forEach(key => {
        this._tags[key] = String(keyValuePairs[key])
      })
    } catch (e) {
      log.error(e)
    }
  }

  _finish (finishTime) {
    if (this._duration !== undefined) {
      return
    }

    finishTime = parseFloat(finishTime) || platform.now()

    this._duration = finishTime - this._startTime
    this._spanContext.trace.finished.push(this)

    if (this._spanContext.sampled) {
      this._parentTracer._record(this)
    }
  }
}

module.exports = DatadogSpan
