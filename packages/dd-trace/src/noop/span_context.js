'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const eventWriter = require('../opentracing/event-writer')
const priority = require('../../../../ext/priority')

const USER_REJECT = priority.USER_REJECT

class NoopSpanContext extends DatadogSpanContext {
  constructor (props) {
    super(props)

    eventWriter.setSamplingPriority(this, USER_REJECT)
  }
}

module.exports = NoopSpanContext
