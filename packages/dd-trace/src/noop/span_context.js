'use strict'

const DatadogSpanContext = require('../opentracing/span_context')
const priority = require('../../../../ext/priority')

const USER_REJECT = priority.USER_REJECT

class NoopSpanContext extends DatadogSpanContext {
  constructor (props) {
    props.sampling = { ...props.sampling }
    super(props)

    this._sampling.priority = USER_REJECT
  }
}

module.exports = NoopSpanContext
