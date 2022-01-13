'use strict'

const SpanContext = require('opentracing').SpanContext

class DatadogSpanContext extends SpanContext {
  constructor (props) {
    super()

    props = props || {}

    const trace = props.trace || {}

    this._traceId = props.traceId
    this._spanId = props.spanId
    this._parentId = props.parentId || null
    this._name = props.name
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = props.sampling || {}
    this._baggageItems = props.baggageItems || {}
    this._noop = props.noop || null
    this._trace = trace
    this._trace.started = trace.started || []
    this._trace.finished = trace.finished || []
    this._trace.tags = trace.tags || {}
  }

  toTraceId () {
    return this._traceId.toString(10)
  }

  toSpanId () {
    return this._spanId.toString(10)
  }
}

module.exports = DatadogSpanContext
