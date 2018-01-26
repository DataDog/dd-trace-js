'use strict'

const Tracer = require('opentracing').Tracer

class DatadogTracer extends Tracer {}

module.exports = DatadogTracer
