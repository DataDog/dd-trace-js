'use strict'

var inherits = require('inherits')
var Tracer = require('opentracing').Tracer

inherits(DatadogTracer, Tracer)

function DatadogTracer () {
  Tracer.call(this)
}

module.exports = DatadogTracer
