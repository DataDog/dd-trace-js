'use strict'

const DatadogSpanContext = require('../opentracing/span_context')

class DatadogCollectorSpanContext extends DatadogSpanContext {}

module.exports = DatadogCollectorSpanContext
