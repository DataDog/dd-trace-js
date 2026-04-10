'use strict'

const { expect } = require('chai')
const { describe, it, beforeEach } = require('tap').mocha

require('./setup/core')

const { getConfigFresh } = require('./helpers/config')
const TextMapPropagator = require('../src/opentracing/propagation/text_map')

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
      'traceparent': '00-00000000000000009c047848bf426236-0798fc2348d88522-01',
      'tracestate': 'dd=s:1;o:rum',
      'x-datadog-origin': 'rum',
      'x-datadog-parent-id': '547464583201719600',
      'x-datadog-sampling-priority': '1',
      'x-datadog-trace-id': '11242242823665377000'
    }

    console.log('\n=== Input Headers ===')
    console.log('x-datadog-trace-id:', headers['x-datadog-trace-id'])
    console.log('x-datadog-parent-id:', headers['x-datadog-parent-id'])
    console.log('traceparent:', headers['traceparent'])

    // Extract the span context
    const spanContext = propagator.extract(headers)

    console.log('\n=== Extracted SpanContext ===')
    expect(spanContext).to.not.be.null

    const extractedTraceId = spanContext.toTraceId()
    const extractedSpanId = spanContext.toSpanId()

    console.log('Extracted Trace ID (decimal):', extractedTraceId)
    console.log('Extracted Trace ID (hex):', spanContext._traceId.toString(16))
    console.log('Extracted Span ID (decimal):', extractedSpanId)
    console.log('Extracted Span ID (hex):', spanContext._spanId.toString(16))
    console.log('Sampling priority:', spanContext._sampling?.priority)
    console.log('Origin:', spanContext._trace?.origin)

    console.log('\n=== Analysis ===')

    // Parse traceparent to understand what it contains
    const traceparentParts = headers['traceparent'].split('-')
    const traceparentTraceIdFull = traceparentParts[1] // 00000000000000009c047848bf426236
    const traceparentTraceIdLower64 = traceparentTraceIdFull.slice(-16) // 9c047848bf426236
    const traceparentSpanId = traceparentParts[2] // 0798fc2348d88522

    console.log('traceparent trace ID (full 128-bit):', traceparentTraceIdFull)
    console.log('traceparent trace ID (lower 64-bit):', traceparentTraceIdLower64)
    console.log('traceparent span ID:', traceparentSpanId)

    // Convert to decimal for comparison
    const traceparentTraceIdDecimal = BigInt('0x' + traceparentTraceIdLower64).toString()
    const traceparentSpanIdDecimal = BigInt('0x' + traceparentSpanId).toString()

    console.log('traceparent trace ID (lower 64-bit) as decimal:', traceparentTraceIdDecimal)
    console.log('traceparent span ID as decimal:', traceparentSpanIdDecimal)

    // Convert x-datadog IDs to hex
    const datadogTraceIdHex = BigInt(headers['x-datadog-trace-id']).toString(16).padStart(16, '0')
    const datadogParentIdHex = BigInt(headers['x-datadog-parent-id']).toString(16).padStart(16, '0')

    console.log('x-datadog-trace-id as hex:', datadogTraceIdHex)
    console.log('x-datadog-parent-id as hex:', datadogParentIdHex)

    // Show what 14454504922740772934 is
    const yourSeenValue = '14454504922740772934'
    const yourSeenValueHex = BigInt(yourSeenValue).toString(16).padStart(16, '0')
    console.log('Your seen value (14454504922740772934) as hex:', yourSeenValueHex)

    console.log('\n=== Explanation ===')
    if (extractedTraceId === headers['x-datadog-trace-id']) {
      console.log('✓ Extracted the x-datadog-trace-id header')
    } else if (extractedTraceId === traceparentTraceIdDecimal) {
      console.log('✓ Extracted from traceparent header (lower 64 bits)')
    } else {
      console.log('⚠ Extracted trace ID does not match either header directly')
      console.log('  This could be due to:')
      console.log('  - Trace ID conversion/casting')
      console.log('  - Signed/unsigned integer handling')
      console.log('  - Propagation style configuration')
    }

    // Check if the value is a signed interpretation
    const traceIdBuffer = Buffer.alloc(8)
    traceIdBuffer.writeBigInt64BE(BigInt(headers['x-datadog-trace-id']))
    const signedInterpretation = traceIdBuffer.readBigInt64BE().toString()
    const unsignedInterpretation = traceIdBuffer.readBigUInt64BE().toString()
    console.log('x-datadog-trace-id as signed int64:', signedInterpretation)
    console.log('x-datadog-trace-id as unsigned int64:', unsignedInterpretation)
  })
})
