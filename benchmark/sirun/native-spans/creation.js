'use strict'

// Span creation benchmark.
//
// Measures the full create-to-finish cycle with varying tag counts.
// The processor is short-circuited so export cost is excluded.
//
// Variants:
//   SCENARIO=bare      — create + finish, no tags
//   SCENARIO=10tags    — create with 10 realistic tags + finish

const tracer = require('../../..').init()

tracer._tracer._processor.process = function (span) {
  this._erase(span.context()._trace)
}

const ITERATIONS = 1_000_000
const scenario = process.env.SCENARIO || 'bare'

if (scenario === 'bare') {
  for (let i = 0; i < ITERATIONS; i++) {
    tracer.startSpan('bench.create.bare').finish()
  }
} else if (scenario === '10tags') {
  for (let i = 0; i < ITERATIONS; i++) {
    const span = tracer.startSpan('bench.create.10tags', {
      tags: {
        'service.name': 'my-service',
        'resource.name': 'GET /users/123',
        'span.type': 'web',
        'http.method': 'GET',
        'http.url': 'https://api.example.com/users/123',
        'http.status_code': 200,
        'component': 'express',
        'custom.tag1': 'some-value',
        'custom.tag2': 42,
        'custom.tag3': 3.14159,
      },
    })
    span.finish()
  }
}
