'use strict'

class DatadogSpanContext {
  constructor (props) {
    props = props || {}

    this._traceId = props.traceId
    this._spanId = props.spanId
    this._parentId = props.parentId || null
    this._name = props.name
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = props.sampling || {}
    this._baggageItems = props.baggageItems || {}
    this._noop = props.noop || null
    this._trace = props.trace || {
      started: [],
      finished: [],
      tags: {}
    }
  }

  toTraceId () {
    return this._traceId.toString(10)
  }

  toSpanId () {
    return this._spanId.toString(10)
  }

  toTraceparent () {
    const sampling = this._sampling.priority > 0 ? '01' : '00'
    const traceId = this._traceId.toString(16).padStart(32, '0')
    const spanId = this._spanId.toString(16).padStart(16, '0')
    return `01-${traceId}-${spanId}-${sampling}`
  }
}

module.exports = DatadogSpanContext
