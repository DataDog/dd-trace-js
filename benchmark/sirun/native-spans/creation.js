'use strict'

// Span creation benchmark.
//
// Measures the full create-to-finish cycle with varying tag counts.
// The processor is short-circuited so export cost is excluded. Spans are
// periodically drained from native storage only to keep the WASM span map
// (and the staged-chunk buffer) bounded over the run — see drainNative.
//
// Variants:
//   SCENARIO=bare      — create + finish, no tags
//   SCENARIO=10tags    — create with 10 realistic tags + finish

const nock = require('nock')

const { createNativeSpanDrain } = require('../native-span-drain')

// Mock the agent so the periodic drain's send resolves instantly and never
// touches the network (the drain exists only to bound memory, not to measure
// export).
nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const tracer = require('../../..').init({ hostname: '127.0.0.1', port: 8126 })

const nativeSpanDrain = createNativeSpanDrain(tracer)

tracer._tracer._processor.process = function (span) {
  nativeSpanDrain.add(span)
  this._erase(span.context()._trace, [])
}

const OPERATIONS = Number(process.env.OPERATIONS) || 100_000
const scenario = process.env.SCENARIO || 'bare'

async function main () {
  if (scenario === 'bare') {
    for (let i = 0; i < OPERATIONS; i++) {
      tracer.startSpan('bench.create.bare').finish()
      if (nativeSpanDrain.needsDrain()) await nativeSpanDrain.drain()
    }
  } else if (scenario === '10tags') {
    for (let i = 0; i < OPERATIONS; i++) {
      const span = tracer.startSpan('bench.create.10tags', {
        tags: {
          'service.name': 'my-service',
          'resource.name': 'GET /users/123',
          'span.type': 'web',
          'http.method': 'GET',
          'http.url': 'https://api.example.com/users/123',
          'http.status_code': 200,
          component: 'express',
          'custom.tag1': 'some-value',
          'custom.tag2': 42,
          'custom.tag3': 3.14159,
        },
      })
      span.finish()
      if (nativeSpanDrain.needsDrain()) await nativeSpanDrain.drain()
    }
  }
  await nativeSpanDrain.drain()
}

main()
