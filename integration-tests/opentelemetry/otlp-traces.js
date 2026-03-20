'use strict'

const tracer = require('dd-trace').init()

const rootSpan = tracer.startSpan('web.request', {
  tags: { 'span.kind': 'server', 'http.method': 'GET', 'http.url': '/api/test' },
})

const childSpan = tracer.startSpan('db.query', {
  childOf: rootSpan,
  tags: { 'span.kind': 'client', 'db.type': 'postgres' },
})
childSpan.finish()

const errorSpan = tracer.startSpan('error.operation', {
  childOf: rootSpan,
})
errorSpan.setTag('error', true)
errorSpan.setTag('error.message', 'test error message')
errorSpan.finish()

rootSpan.finish()

// Allow time for the HTTP export request to complete
setTimeout(() => process.exit(0), 1500)
