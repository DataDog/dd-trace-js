'use strict'

const tracer = require('dd-trace').init()

const { TracerProvider } = tracer

const provider = new TracerProvider()
provider.register()

const ot = require('@opentelemetry/api')

const otelTracer = ot.trace.getTracer(
  'my-service-tracer'
)

const http = require('http')

const server = http.createServer()

server.listen(() => {
  setImmediate(() => {
    const { port } = server.address()
    http.get(`http://localhost:${port}`)
  })
})

server.on('request', async (_req, res) => {
  otelTracer.startActiveSpan('otel-sub', otelSpan => {
    setImmediate(() => {
      otelSpan.end()
      tracer.trace('dd-sub', (span) => {
        setImmediate(() => {
          span.finish()

          res.end('done')
          server.close()
        })
      })
    })
  })
})
