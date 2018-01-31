'use strict'

const apiCompatibilityChecks = require('opentracing/lib/test/api_compatibility').default
const DatadogTracer = require('../../src/opentracing/tracer')

apiCompatibilityChecks(() => {
  const clock = sinon.useFakeTimers()
  const tracer = new DatadogTracer({ service: 'test' })

  clock.restore()

  return tracer
})
