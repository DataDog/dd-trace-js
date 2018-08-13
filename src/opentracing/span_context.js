'use strict'

const SpanContext = require('opentracing').SpanContext

class DatadogSpanContext extends SpanContext {
  constructor (props) {
    super()

    this.traceId = props.traceId
    this.spanId = props.spanId
    this.parentId = props.parentId || null
    if (props.samplingPriority !== undefined) {
      this.samplingPriority = props.samplingPriority
    }
    this.sampled = props.sampled === undefined || props.sampled
    this.baggageItems = props.baggageItems || {}
    this.trace = props.trace || {
      started: [],
      finished: []
    }
  }
}

module.exports = DatadogSpanContext
