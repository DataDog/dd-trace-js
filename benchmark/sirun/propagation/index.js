'use strict'

const assert = require('node:assert/strict')

const id = require('../../../packages/dd-trace/src/id')
const SpanContext = require('../../../packages/dd-trace/src/opentracing/span_context')
const TextMapPropagator = require('../../../packages/dd-trace/src/opentracing/propagation/text_map')

const { VARIANT } = process.env

const ITERATIONS = 300_000

// Duck-typed config keeps the bench out of the full `Config` singleton (telemetry
// registration, env reads). The propagator only reads the fields below.
const propagator = new TextMapPropagator({
  tracePropagationStyle: {
    extract: ['datadog', 'tracecontext', 'baggage'],
    inject: ['datadog', 'tracecontext', 'baggage'],
  },
  legacyBaggageEnabled: false,
  baggageMaxItems: 64,
  baggageMaxBytes: 8192,
  tagsHeaderMaxLength: 512,
  tracePropagationExtractFirst: false,
  tracePropagationBehaviorExtract: 'continue',
  baggageTagKeys: ['user.id', 'session.id', 'account.id'],
})

// Realistic incoming carrier: traceparent + 4-vendor tracestate + 4-key baggage. Most
// production baggage is plain ASCII (tenant / user / session / locale); the percent
// variant lives below for the slow-path no-regression check.
const EXTRACT_CARRIER_ASCII = {
  traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
  tracestate: 'dd=s:2;p:abc,vendor1=k1:v1,vendor2=k1:v1;k2:v2,foo=bar',
  baggage: 'tenant=acme,user=ada,session=abcdef0123456789,locale=en-US',
}

const EXTRACT_CARRIER_PERCENT = {
  ...EXTRACT_CARRIER_ASCII,
  baggage: 'tenant=acme%20corp,path=%2Forders%2Fnew,note=hello%20world',
}

const injectContext = new SpanContext({
  traceId: id('1234567890abcdef'),
  spanId: id('abcdef1234567890'),
  sampling: { priority: 1 },
  baggageItems: { tenant: 'acme', user: 'ada', session: 'abcdef0123456789' },
  trace: {
    tags: { '_dd.p.dm': '-1', '_dd.p.tid': '1234567890abcdef' },
    started: [],
    finished: [],
  },
})

// Pre-flight: confirm extract / inject are doing real work; catches a silent
// breakage where the duck-typed config is missing a field the propagator now reads.
const sanityExtract = propagator.extract(EXTRACT_CARRIER_ASCII)
assert.ok(sanityExtract?._traceId, 'extract returned no trace id')

const sanityInjected = {}
propagator.inject(injectContext, sanityInjected)
assert.ok(sanityInjected.traceparent && sanityInjected['x-datadog-trace-id'], 'inject populated no headers')

if (VARIANT === 'extract' || VARIANT === 'extract-baggage-ascii') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    propagator.extract(EXTRACT_CARRIER_ASCII)
  }
} else if (VARIANT === 'extract-baggage-percent') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    propagator.extract(EXTRACT_CARRIER_PERCENT)
  }
} else if (VARIANT === 'inject') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    propagator.inject(injectContext, {})
  }
} else if (VARIANT === 'extract-inject') {
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const extracted = propagator.extract(EXTRACT_CARRIER_ASCII)
    propagator.inject(extracted, {})
  }
}
