'use strict'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.lOG_INJECTION) {
  options.logInjection = process.env.lOG_INJECTION
}

const tracer = require('dd-trace').init(options)

const http = require('http')
const logger = require('pino')()

const server = http
  .createServer((req, res) => {
    const span = tracer.scope().active()
    const contextTraceId = span.context().toTraceId(true)
    const contextSpanId = span.context().toSpanId()
    logger.info(
      { custom: { trace_id: contextTraceId, span_id: contextSpanId } },
      'Creating server'
    )
    res.end('hello, world\n')
  })
  .listen(0, () => {
    const port = server.address().port
    process.send({ port })
  })
