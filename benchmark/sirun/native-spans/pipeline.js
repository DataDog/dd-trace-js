'use strict'

// Full pipeline benchmark (create → tag → finish → process).
//
// Unlike the other benchmarks, the processor is NOT short-circuited here.
// This measures the cost of SpanProcessor.process() — the critical
// difference being that JS mode calls spanFormat() for every span while
// native mode skips it entirely.
//
// The exporter's export() is stubbed to a no-op so we measure the
// process path without network or serialization overhead.

const nock = require('nock')

nock.disableNetConnect()

const tracer = require('../../..').init({
  hostname: '127.0.0.1',
  port: 8126,
})

// Stub export to a no-op — we only want to measure process()
tracer._tracer._exporter.export = function () {}

const ITERATIONS = 200_000

for (let i = 0; i < ITERATIONS; i++) {
  const root = tracer.startSpan('web.request', {
    tags: {
      'service.name': 'web-app',
      'resource.name': 'GET /api/users/123',
      'span.type': 'web',
      'http.method': 'GET',
      'http.url': 'https://api.example.com/users/123',
    },
  })

  const db = tracer.startSpan('postgresql.query', {
    childOf: root,
    tags: {
      'service.name': 'postgresql',
      'resource.name': 'SELECT * FROM users WHERE id = $1',
      'span.type': 'sql',
      'db.type': 'postgresql',
      'db.name': 'mydb',
    },
  })
  db.setTag('db.row_count', 1)
  db.finish()

  const cache = tracer.startSpan('redis.command', {
    childOf: root,
    tags: {
      'service.name': 'redis',
      'resource.name': 'GET',
      'span.type': 'cache',
      'cache.backend': 'redis',
    },
  })
  cache.setTag('cache.hit', true)
  cache.finish()

  root.setTag('http.status_code', 200)
  root.finish()
}
