'use strict'

const SpanContext = require('opentracing').SpanContext

const id = require('../id')

class DatadogSpanContext extends SpanContext {
  constructor (props) {
    super()

    props = props || {}

    this._spanData = {
      name: props.name,
      trace_id: props.traceId,
      span_id: props.spanId,
      parent_id: props.parentId || id(0),
      error: 0,
      metrics: {},
      meta: {}
    }
    this._isFinished = props.isFinished || false
    this._tags = props.tags || {}
    this._sampling = props.sampling || {}
    this._baggageItems = props.baggageItems || {}
    this._traceFlags = props.traceFlags || {}
    this._traceFlags.sampled = this._traceFlags.sampled !== false
    this._traceFlags.debug = this._traceFlags.debug === true
    this._noop = props.noop || null
    this._trace = props.trace || {
      started: [],
      finished: []
    }
  }

  toTraceId () {
    return this._traceId.toString(10)
  }

  toSpanId () {
    return this._spanId.toString(10)
  }
}

aliasToData('_traceId', 'trace_id')
aliasToData('_spanId', 'span_id')
aliasToData('_parentId', 'parent_id')
aliasToData('_name', 'name')

module.exports = DatadogSpanContext

function aliasToData (propName, dataPropName) {
  Reflect.defineProperty(DatadogSpanContext.prototype, propName, {
    get () {
      return this._spanData[dataPropName]
    },
    set (val) {
      this._spanData[dataPropName] = val
    },
    enumerable: true,
    configurable: true
  })
}
