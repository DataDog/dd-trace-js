'use strict'

const assert = require('node:assert/strict')
const { describe, it, beforeEach } = require('mocha')

require('./setup/core')

const TextMapPropagator = require('../src/opentracing/propagation/text_map')
const { getConfigFresh } = require('./helpers/config')

describe('Extract from your API Gateway event', () => {
  let propagator
  let config

  beforeEach(() => {
    config = getConfigFresh()
    propagator = new TextMapPropagator(config)
  })

  it('should extract and show trace IDs from your headers', () => {
    // Your actual event headers
    const headers = {
      traceparent: '00-00000000000000009c047848bf426236-0798fc2348d88522-01',
      tracestate: 'dd=s:1;o:rum',
      'x-datadog-origin': 'rum',
      'x-datadog-parent-id': '547464583201719600',
      'x-datadog-sampling-priority': '1',
      'x-datadog-trace-id': '11242242823665377000',
    }

    // Extract the span context
    const spanContext = propagator.extract(headers)

    assert.ok(spanContext !== null && spanContext !== undefined)

    const extractedTraceId = spanContext.toTraceId()

    // Verify extraction succeeded
    assert.ok(extractedTraceId !== null && extractedTraceId !== undefined)
  })
})
