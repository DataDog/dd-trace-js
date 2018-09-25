'use strict'

const SpanContext = require('opentracing').SpanContext

class DatadogSpanContext extends SpanContext {
  constructor (props) {
    super()

    this.traceId = props.traceId
    this.spanId = props.spanId
    this.parentId = props.parentId || null
    this.tags = props.tags || {}
    this.metrics = props.metrics || {}
    this.sampled = props.sampled === undefined || props.sampled
    this.sampling = props.sampling || {}
    this.baggageItems = props.baggageItems || {}
    this.trace = props.trace || {
      started: [],
      finished: []
    }
  }
}

module.exports = DatadogSpanContext
