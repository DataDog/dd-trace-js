'use strict'

var apiCompatibilityChecks = require('opentracing/lib/test/api_compatibility').default
var DatadogTracer = require('../../src/opentracing/tracer')

apiCompatibilityChecks(function () {
  return new DatadogTracer({ service: 'test' })
})
