'use strict'

const { AUTO_KEEP } = require('../../../../ext/priority')

// the lowercase, hex encoded upper 64 bits of a 128-bit trace id, if present
const TRACE_ID_128 = '_dd.p.tid'

class DatadogSpanContext {
  constructor (props) {
    props = props || {}

    this._traceId = props.traceId
    this._spanId = props.spanId
    this._isRemote = props.isRemote ?? true
    this._parentId = props.parentId || null
    this._name = props.name
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = props.sampling || {}
    this._spanSampling = undefined
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

  toTraceId (get128bitId = false) {
    if (get128bitId) {
      return this._traceId.toBuffer().length <= 8 && this._trace.tags[TRACE_ID_128]
        ? this._trace.tags[TRACE_ID_128] + this._traceId.toString(16).padStart(16, '0')
        : this._traceId.toString(16).padStart(32, '0')
    }
    return this._traceId.toString(10)
  }

  toSpanId (get128bitId = false) {
    if (get128bitId) {
      return this._spanId.toString(16).padStart(16, '0')
    }
    return this._spanId.toString(10)
  }

  toTraceparent () {
    const flags = this._sampling.priority >= AUTO_KEEP ? '01' : '00'
    const traceId = this.toTraceId(true)
    const spanId = this.toSpanId(true)
    const version = (this._traceparent && this._traceparent.version) || '00'
    return `${version}-${traceId}-${spanId}-${flags}`
  }
}

module.exports = DatadogSpanContext
