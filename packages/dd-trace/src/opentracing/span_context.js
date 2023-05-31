'use strict'

const { AUTO_KEEP } = require('../../../../ext/priority')

class DatadogSpanContext {
  constructor (props) {
    props = props || {}

    this._traceId = props.traceId
    this._spanId = props.spanId
    this._parentId = props.parentId || null
    this._name = props.name
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = Object.assign({}, props.sampling)
    this._baggageItems = props.baggageItems || {}
    this._traceparent = props.traceparent
    this._tracestate = props.tracestate
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
    const flags = this._sampling.priority >= AUTO_KEEP ? '01' : '00'
    const traceId = this._traceId.toBuffer().length <= 8 && this._trace.tags['_dd.p.tid']
      ? this._trace.tags['_dd.p.tid'] + this._traceId.toString(16).padStart(16, '0')
      : this._traceId.toString(16).padStart(32, '0')
    const spanId = this._spanId.toString(16).padStart(16, '0')
    const version = (this._traceparent && this._traceparent.version) || '00'
    return `${version}-${traceId}-${spanId}-${flags}`
  }
}

module.exports = DatadogSpanContext
