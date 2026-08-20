'use strict'

const tracer = require('../..')

const requestContext = Symbol.for('@vercel/request-context')
let retained
globalThis[requestContext] = {
  get: () => ({ waitUntil: promise => { retained = promise } }),
}

const otelEnabled = process.env.VERCEL_TEST_OTEL === '1'
const spanMetadataEnabled = process.env.VERCEL_TEST_SPAN_METADATA === '1'
let config = { apmTracingEnabled: false }
if (otelEnabled) {
  config = { service: 'serverless-flush' }
} else if (spanMetadataEnabled) {
  config = {
    flushInterval: 0,
    service: 'vercel-metadata-test',
    tags: { 'vercel.region': 'custom-region' },
  }
}
tracer.init(config)

// The tracer must install its core-module hook before the application loads HTTP.
// eslint-disable-next-line import/order
const http = require('node:http')
const logs = otelEnabled ? require('@opentelemetry/api-logs').logs : undefined
const metrics = otelEnabled ? require('@opentelemetry/api').metrics : undefined

if (spanMetadataEnabled) {
  tracer.startSpan('vercel-span').finish()
} else {
  const application = http.createServer((request, response) => {
    request.resume()
    response.end()
  })

  process.once('message', message => {
    if (message !== 'request') return

    if (otelEnabled) {
      tracer.trace('serverless.flush', {}, () => {})
      logs.getLogger('serverless-flush').emit({ body: 'flush me' })
      metrics.getMeter('serverless-flush').createCounter('flush.me').add(1)
    }

    http.get(`http://127.0.0.1:${application.address().port}`, response => {
      response.resume()
      response.once('end', async () => {
        process.send({ type: 'retained', value: Boolean(retained) })
        await retained
        metrics?.getMeterProvider()?.reader?.shutdown()
        logs?.getLoggerProvider()?.shutdown?.()
        process.send({ type: 'released' }, () => {
          application.close(() => process.disconnect())
        })
      })
    })
  })

  application.listen(0, '127.0.0.1', () => process.send({ type: 'ready' }))
}
