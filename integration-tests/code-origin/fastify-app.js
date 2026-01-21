'use strict'

// @ts-expect-error This code is running in a sandbox where dd-trace is available
const tracer = require('dd-trace')

tracer.init({ flushInterval: 1 })

// @ts-expect-error This code is running in a sandbox where fastify is available
const fastify = require('fastify')
const app = fastify()

app.get('/hello', (req, res) => {
  res.send({ message: 'Hello World' })
})

app.get('/config', (req, res) => {
  const config = tracer._tracer._config
  res.send({
    codeOriginEnabled: config.codeOriginForSpans.enabled,
    remoteConfigEnabled: config.remoteConfig.enabled
  })
})

app.listen({ port: process.env.APP_PORT || 0 }, (error) => {
  if (error) {
    throw error
  }
  process.send?.({ port: app.server.address().port })
})
