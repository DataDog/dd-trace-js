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
    if (props.sampled !== undefined) {
      this.sampled = props.sampled
    } else if (this.samplingPriority !== undefined) {
      this.sampled = this.samplingPriority > 0
    } else {
      this.sampled = true
    }
    this.baggageItems = props.baggageItems || {}
    this.trace = props.trace || {
      started: [],
      finished: []
    }
  }
}

module.exports = DatadogSpanContext
