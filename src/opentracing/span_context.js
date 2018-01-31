'use strict'

const SpanContext = require('opentracing').SpanContext

class DatadogSpanContext extends SpanContext {
  constructor (props) {
    super()

    this.traceId = props.traceId
    this.spanId = props.spanId
    this.sampled = props.sampled === undefined || props.sampled
    this.baggageItems = props.baggageItems || {}
  }
}

module.exports = DatadogSpanContext
