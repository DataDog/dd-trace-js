'use strict'

// Full pipeline benchmark (create → tag → finish → process).
//
// Unlike the other benchmarks, the processor is NOT short-circuited here.
// This measures the cost of SpanProcessor.process() — the critical
// difference being that JS mode calls spanFormat() for every span while
// native mode skips it entirely.
//
// The exporter's export() is replaced with a collector so we measure the
// process path without the real send; spans are periodically drained from
// native storage (extract + mocked-agent send) only to bound memory.

const nock = require('nock')

const { createNativeSpanDrain } = require('../native-span-drain')

nock.disableNetConnect()
nock('http://127.0.0.1:8126').persist().put(/.*/).reply(200, '{}').post(/.*/).reply(200, '{}')

const tracer = require('../../..').init({
  hostname: '127.0.0.1',
  port: 8126,
})

const nativeSpanDrain = createNativeSpanDrain(tracer)

// Collect finished span ids; the actual drain happens in the (async) main loop
// so it can await the staging-clearing send.
tracer._tracer._exporter.export = function (spans) {
  nativeSpanDrain.addAll(spans)
}

const OPERATIONS = Number(process.env.OPERATIONS) || 50_000

async function main () {
  for (let i = 0; i < OPERATIONS; i++) {
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

    if (nativeSpanDrain.needsDrain()) await nativeSpanDrain.drain()
  }
  await nativeSpanDrain.drain()
}

main()
