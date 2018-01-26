'use strict'

const apiCompatibilityChecks = require('opentracing/lib/test/api_compatibility').default
const DatadogTracer = require('../../src/opentracing/tracer')

apiCompatibilityChecks(() => new DatadogTracer({ service: 'test' }))
